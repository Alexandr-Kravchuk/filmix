import { fetchDecodedPlaylistJson, findEpisodeSourceUrl, resolvePlaylistUrlFromPlayerData } from './playerjs-service.js';

function buildEpisodeKey(season, episode) {
  return `${season}:${episode}`;
}
function parseTtl(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function createEntry(value, ttlMs) {
  const now = Date.now();
  return {
    value,
    freshUntil: now + ttlMs,
    staleUntil: now + Math.max(ttlMs * 10, ttlMs + 60000)
  };
}
function isFresh(entry, now = Date.now()) {
  return !!entry && now < entry.freshUntil;
}
function isStale(entry, now = Date.now()) {
  return !!entry && now >= entry.freshUntil && now < entry.staleUntil;
}

export function createSourceCacheService(config = {}) {
  const sourceCacheTtlMs = parseTtl(config.sourceCacheTtlMs, 1800000);
  const playlistCacheTtlMs = parseTtl(config.playlistCacheTtlMs, 600000);
  const playerDataCacheTtlMs = parseTtl(config.playerDataCacheTtlMs, 60000);
  const sourceCache = new Map();
  const playlistCache = new Map();
  let playerDataCache = null;
  let playerDataRefresh = null;
  const playlistRefreshByKey = new Map();
  const sourceRefreshByKey = new Map();
  async function runPlayerDataRefresh() {
    if (playerDataRefresh) {
      return playerDataRefresh;
    }
    playerDataRefresh = (async () => {
      const payload = await config.fetchPlayerData();
      playerDataCache = createEntry(payload, playerDataCacheTtlMs);
      return payload;
    })();
    try {
      return await playerDataRefresh;
    } finally {
      playerDataRefresh = null;
    }
  }
  async function getPlayerData() {
    if (!playerDataCache) {
      return runPlayerDataRefresh();
    }
    if (isFresh(playerDataCache)) {
      return playerDataCache.value;
    }
    if (isStale(playerDataCache)) {
      void runPlayerDataRefresh().catch(() => {
      });
      return playerDataCache.value;
    }
    return runPlayerDataRefresh();
  }
  async function getPlayerDataFresh() {
    return runPlayerDataRefresh();
  }
  async function runPlaylistRefresh(playlistUrl) {
    const key = String(playlistUrl || '').trim();
    if (!key) {
      throw new Error('Playlist URL is empty');
    }
    if (playlistRefreshByKey.has(key)) {
      return playlistRefreshByKey.get(key);
    }
    const task = (async () => {
      const playlistJson = await fetchDecodedPlaylistJson(key, {
        fetchImpl: config.fetchImpl,
        userAgent: config.userAgent,
        decodeConfig: config.decodeConfig
      });
      playlistCache.set(key, createEntry(playlistJson, playlistCacheTtlMs));
      return playlistJson;
    })();
    playlistRefreshByKey.set(key, task);
    try {
      return await task;
    } finally {
      playlistRefreshByKey.delete(key);
    }
  }
  async function getPlaylist(playlistUrl) {
    const key = String(playlistUrl || '').trim();
    const entry = playlistCache.get(key);
    if (!entry) {
      return runPlaylistRefresh(key);
    }
    if (isFresh(entry)) {
      return entry.value;
    }
    if (isStale(entry)) {
      void runPlaylistRefresh(key).catch(() => {
      });
      return entry.value;
    }
    return runPlaylistRefresh(key);
  }
  async function getPlaylistFresh(playlistUrl) {
    return runPlaylistRefresh(playlistUrl);
  }
  async function resolveFromPlayerDataWith(data, season, episode, forcePlaylistRefresh = false) {
    const { playlistUrl } = resolvePlaylistUrlFromPlayerData(data, {
      preferredTranslationPattern: config.preferredTranslationPattern,
      decodeConfig: config.decodeConfig
    });
    const playlistJson = forcePlaylistRefresh ? await getPlaylistFresh(playlistUrl) : await getPlaylist(playlistUrl);
    const sourceUrl = findEpisodeSourceUrl(playlistJson, season, episode, config.preferredQuality || Number.MAX_SAFE_INTEGER);
    if (!sourceUrl) {
      const error = new Error('episode source was not found in decoded playlist');
      error.code = 'EPISODE_SOURCE_NOT_FOUND';
      throw error;
    }
    return {
      sourceUrl,
      origin: 'player-data'
    };
  }
  async function computeFreshSource(season, episode) {
    let playerData = null;
    try {
      playerData = await getPlayerData();
      return await resolveFromPlayerDataWith(playerData, season, episode, false);
    } catch (error) {
      if (error && error.code === 'EPISODE_SOURCE_NOT_FOUND') {
        return config.resolveCatalogSource(season, episode, { playerData });
      }
    }
    try {
      const freshPlayerData = await getPlayerDataFresh();
      return await resolveFromPlayerDataWith(freshPlayerData, season, episode, true);
    } catch (error) {
      if (error && error.code === 'EPISODE_SOURCE_NOT_FOUND') {
        return config.resolveCatalogSource(season, episode, { playerData });
      }
    }
    return config.resolveCatalogSource(season, episode, { playerData });
  }
  async function runSourceRefresh(season, episode) {
    const key = buildEpisodeKey(season, episode);
    if (sourceRefreshByKey.has(key)) {
      return sourceRefreshByKey.get(key);
    }
    const task = (async () => {
      const value = await computeFreshSource(season, episode);
      sourceCache.set(key, createEntry(value, sourceCacheTtlMs));
      return value;
    })();
    sourceRefreshByKey.set(key, task);
    try {
      return await task;
    } finally {
      sourceRefreshByKey.delete(key);
    }
  }
  async function resolveEpisodeSource(season, episode) {
    const key = buildEpisodeKey(season, episode);
    const cached = sourceCache.get(key);
    if (cached && isFresh(cached)) {
      return cached.value;
    }
    if (cached && isStale(cached)) {
      void runSourceRefresh(season, episode).catch(() => {
      });
      return cached.value;
    }
    if (cached) {
      try {
        return await runSourceRefresh(season, episode);
      } catch {
        return cached.value;
      }
    }
    return runSourceRefresh(season, episode);
  }
  async function resolveEpisodeSourcesBatch(season, episodes) {
    const normalizedEpisodes = Array.from(new Set((Array.isArray(episodes) ? episodes : [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0))).sort((a, b) => a - b);
    if (!normalizedEpisodes.length) {
      return [];
    }
    const tasks = normalizedEpisodes.map(async (episode) => {
      try {
        const resolved = await resolveEpisodeSource(season, episode);
        return {
          episode,
          sourceUrl: resolved.sourceUrl,
          origin: resolved.origin
        };
      } catch {
        return null;
      }
    });
    const items = await Promise.all(tasks);
    return items.filter(Boolean);
  }
  function clear() {
    sourceCache.clear();
    playlistCache.clear();
    playerDataCache = null;
  }
  return {
    resolveEpisodeSource,
    resolveEpisodeSourcesBatch,
    clear
  };
}

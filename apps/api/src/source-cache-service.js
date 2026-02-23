import { fetchDecodedPlaylistJson, findEpisodeVariants, pickVariant, resolvePlaylistUrlsFromPlayerData } from './playerjs-service.js';

function buildEpisodeKey(season, episode) {
  return `${season}:${episode}`;
}
function normalizeQualityKey(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'max';
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return 'max';
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'max';
  }
  return String(parsed);
}
function buildSourceKey(season, episode, preferredQuality) {
  return `${season}:${episode}:${normalizeQualityKey(preferredQuality)}`;
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
function normalizeSourcesByQuality(sources) {
  return [...(Array.isArray(sources) ? sources : [])]
    .filter((source) => source && typeof source.sourceUrl === 'string' && source.sourceUrl)
    .map((source) => ({
      quality: Number.isFinite(Number(source.quality)) ? Number.parseInt(String(source.quality), 10) : 0,
      sourceUrl: source.sourceUrl,
      origin: source.origin || ''
    }))
    .sort((a, b) => a.quality - b.quality);
}
function pickSourceByQuality(sources, preferredQuality) {
  const normalizedSources = normalizeSourcesByQuality(sources);
  if (!normalizedSources.length) {
    return null;
  }
  const variants = normalizedSources.map((item) => ({ quality: item.quality, url: item.sourceUrl }));
  const selected = pickVariant(variants, preferredQuality);
  if (!selected) {
    return null;
  }
  const matched = normalizedSources.find((item) => item.sourceUrl === selected.url && item.quality === selected.quality);
  return {
    sourceUrl: selected.url,
    quality: selected.quality,
    origin: matched && matched.origin ? matched.origin : normalizedSources[0].origin
  };
}

export function createSourceCacheService(config = {}) {
  const sourceCacheTtlMs = parseTtl(config.sourceCacheTtlMs, 1800000);
  const playlistCacheTtlMs = parseTtl(config.playlistCacheTtlMs, 600000);
  const playerDataCacheTtlMs = parseTtl(config.playerDataCacheTtlMs, 60000);
  const sourceCache = new Map();
  const ladderCache = new Map();
  const playlistCache = new Map();
  let playerDataCache = null;
  let playerDataRefresh = null;
  const playlistRefreshByKey = new Map();
  const ladderRefreshByKey = new Map();
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
  async function resolveLadderFromPlayerData(data, season, episode, forcePlaylistRefresh = false) {
    const candidates = resolvePlaylistUrlsFromPlayerData(data, {
      preferredTranslationPattern: config.preferredTranslationPattern,
      decodeConfig: config.decodeConfig
    });
    for (const candidate of candidates) {
      let playlistJson = null;
      try {
        playlistJson = forcePlaylistRefresh ? await getPlaylistFresh(candidate.playlistUrl) : await getPlaylist(candidate.playlistUrl);
      } catch {
        continue;
      }
      const variants = findEpisodeVariants(playlistJson, season, episode).map((variant) => ({
        quality: variant.quality,
        sourceUrl: variant.url,
        origin: 'player-data'
      }));
      if (!variants.length) {
        continue;
      }
      return {
        sources: normalizeSourcesByQuality(variants),
        origin: 'player-data'
      };
    }
    const error = new Error('episode source was not found in decoded playlist');
    error.code = 'EPISODE_SOURCE_NOT_FOUND';
    throw error;
  }
  async function computeFreshLadder(season, episode) {
    let playerData = null;
    try {
      playerData = await getPlayerData();
      return await resolveLadderFromPlayerData(playerData, season, episode, false);
    } catch (error) {
      if (error && error.code === 'EPISODE_SOURCE_NOT_FOUND') {
        return config.resolveCatalogLadder(season, episode, { playerData });
      }
    }
    try {
      const freshPlayerData = await getPlayerDataFresh();
      return await resolveLadderFromPlayerData(freshPlayerData, season, episode, true);
    } catch (error) {
      if (error && error.code === 'EPISODE_SOURCE_NOT_FOUND') {
        return config.resolveCatalogLadder(season, episode, { playerData });
      }
    }
    return config.resolveCatalogLadder(season, episode, { playerData });
  }
  async function runLadderRefresh(season, episode) {
    const key = buildEpisodeKey(season, episode);
    if (ladderRefreshByKey.has(key)) {
      return ladderRefreshByKey.get(key);
    }
    const task = (async () => {
      const value = await computeFreshLadder(season, episode);
      ladderCache.set(key, createEntry(value, playlistCacheTtlMs));
      return value;
    })();
    ladderRefreshByKey.set(key, task);
    try {
      return await task;
    } finally {
      ladderRefreshByKey.delete(key);
    }
  }
  async function resolveEpisodeSourceLadder(season, episode) {
    const key = buildEpisodeKey(season, episode);
    const cached = ladderCache.get(key);
    if (cached && isFresh(cached)) {
      return cached.value;
    }
    if (cached && isStale(cached)) {
      void runLadderRefresh(season, episode).catch(() => {
      });
      return cached.value;
    }
    if (cached) {
      try {
        return await runLadderRefresh(season, episode);
      } catch {
        return cached.value;
      }
    }
    return runLadderRefresh(season, episode);
  }
  async function computeFreshSource(season, episode, preferredQuality) {
    const ladder = await resolveEpisodeSourceLadder(season, episode);
    const selected = pickSourceByQuality(ladder.sources, preferredQuality);
    if (!selected) {
      const error = new Error('Episode not found or no sources available');
      error.statusCode = 404;
      throw error;
    }
    return selected;
  }
  async function runSourceRefresh(season, episode, preferredQuality) {
    const key = buildSourceKey(season, episode, preferredQuality);
    if (sourceRefreshByKey.has(key)) {
      return sourceRefreshByKey.get(key);
    }
    const task = (async () => {
      const value = await computeFreshSource(season, episode, preferredQuality);
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
  async function resolveEpisodeSource(season, episode, preferredQuality = 'max') {
    const key = buildSourceKey(season, episode, preferredQuality);
    const cached = sourceCache.get(key);
    if (cached && isFresh(cached)) {
      return cached.value;
    }
    if (cached && isStale(cached)) {
      void runSourceRefresh(season, episode, preferredQuality).catch(() => {
      });
      return cached.value;
    }
    if (cached) {
      try {
        return await runSourceRefresh(season, episode, preferredQuality);
      } catch {
        return cached.value;
      }
    }
    return runSourceRefresh(season, episode, preferredQuality);
  }
  async function resolveEpisodeSourcesBatch(season, episodes, preferredQuality = 'max') {
    const normalizedEpisodes = Array.from(new Set((Array.isArray(episodes) ? episodes : [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0))).sort((a, b) => a - b);
    if (!normalizedEpisodes.length) {
      return [];
    }
    const tasks = normalizedEpisodes.map(async (episode) => {
      try {
        const resolved = await resolveEpisodeSource(season, episode, preferredQuality);
        return {
          episode,
          sourceUrl: resolved.sourceUrl,
          origin: resolved.origin,
          quality: resolved.quality
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
    ladderCache.clear();
    playlistCache.clear();
    playerDataCache = null;
  }
  return {
    resolveEpisodeSource,
    resolveEpisodeSourcesBatch,
    resolveEpisodeSourceLadder,
    clear
  };
}

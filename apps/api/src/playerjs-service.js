const defaultDecodeConfig = Object.freeze({
  file3Separator: ':<:',
  bk0: '2owKDUoGzsuLNEyhNx',
  bk1: '19n1iKBr89ubskS5zT',
  bk2: 'IDaBt08C9Wf7lYr0eH',
  bk3: 'lNjI9V5U1gMnsxt4Qr',
  bk4: 'o9wPt0ii42GWeS7L7A'
});
export function getDefaultDecodeConfig() {
  return defaultDecodeConfig;
}

function encodeUtf8ToBase64(value) {
  const normalized = encodeURIComponent(String(value || '')).replace(/%([0-9A-F]{2})/g, (match, code) =>
    String.fromCharCode(Number.parseInt(code, 16))
  );
  return Buffer.from(normalized, 'binary').toString('base64');
}

function decodeBase64ToUtf8(value) {
  const binary = Buffer.from(String(value || ''), 'base64').toString('binary');
  const percentEncoded = binary
    .split('')
    .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  return decodeURIComponent(percentEncoded);
}

function parseQualityVariants(fileValue) {
  const chunks = String(fileValue || '')
    .split(',')
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const variants = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^\[([^\]]+)\](.+)$/);
    if (!match) {
      continue;
    }
    const quality = Number.parseInt(match[1], 10);
    variants.push({
      quality: Number.isFinite(quality) ? quality : 0,
      url: match[2]
    });
  }
  return variants;
}

function normalizeQualityPreference(preferredQuality) {
  if (preferredQuality === undefined || preferredQuality === null || String(preferredQuality).trim() === '') {
    return Number.MAX_SAFE_INTEGER;
  }
  const normalized = String(preferredQuality).trim().toLowerCase();
  if (normalized === 'min' || normalized === 'lowest' || normalized === 'low') {
    return 1;
  }
  if (normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parsed;
}
function sortQualityAsc(variants) {
  return [...variants].sort((a, b) => a.quality - b.quality);
}
export function pickVariant(variants, preferredQuality) {
  if (!variants.length) {
    return null;
  }
  const preferred = normalizeQualityPreference(preferredQuality);
  if (preferred === Number.MAX_SAFE_INTEGER) {
    return sortQualityAsc(variants).at(-1);
  }
  const sorted = sortQualityAsc(variants);
  const exact = sorted.find((item) => item.quality === preferred);
  if (exact) {
    return exact;
  }
  const lower = [...sorted].reverse().find((item) => item.quality < preferred);
  if (lower) {
    return lower;
  }
  return sorted[0];
}

function parseEpisodeId(idValue) {
  const match = String(idValue || '').match(/^s0*(\d+)e0*(\d+)$/i);
  if (!match) {
    return null;
  }
  const season = Number.parseInt(match[1], 10);
  const episode = Number.parseInt(match[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { season, episode };
}

export function pickTranslation(videoTranslations, preferredTranslationPattern) {
  const entries = Object.entries(videoTranslations || {}).filter((entry) => typeof entry[1] === 'string' && entry[1].startsWith('#2'));
  if (!entries.length) {
    return null;
  }
  if (preferredTranslationPattern) {
    const pattern = new RegExp(preferredTranslationPattern, 'i');
    const preferred = entries.find(([name]) => pattern.test(name));
    if (preferred) {
      return preferred;
    }
  }
  const english = entries.find(([name]) => /eng|english|англ|ориг|original/i.test(name));
  if (english) {
    return english;
  }
  return null;
}
function orderTranslationEntries(entries, preferredTranslationPattern) {
  const ordered = [];
  const consumed = new Set();
  if (preferredTranslationPattern) {
    const pattern = new RegExp(preferredTranslationPattern, 'i');
    for (let index = 0; index < entries.length; index += 1) {
      if (!pattern.test(entries[index][0])) {
        continue;
      }
      ordered.push(entries[index]);
      consumed.add(index);
      break;
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    if (!/eng|english|англ|ориг|original/i.test(entries[index][0])) {
      continue;
    }
    ordered.push(entries[index]);
    consumed.add(index);
    break;
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }
    ordered.push(entries[index]);
  }
  return ordered;
}

export function findEpisodeSourceUrl(playlistJson, season, episode, preferredQuality) {
  const variants = findEpisodeVariants(playlistJson, season, episode);
  const selected = pickVariant(variants, preferredQuality);
  return selected ? selected.url : null;
}
export function findEpisodeVariants(playlistJson, season, episode) {
  if (!Array.isArray(playlistJson)) {
    return [];
  }
  for (const seasonEntry of playlistJson) {
    const folder = seasonEntry && Array.isArray(seasonEntry.folder) ? seasonEntry.folder : [];
    for (const episodeEntry of folder) {
      const parsedId = parseEpisodeId(episodeEntry ? episodeEntry.id : '');
      if (!parsedId) {
        continue;
      }
      if (parsedId.season !== season || parsedId.episode !== episode) {
        continue;
      }
      return sortQualityAsc(parseQualityVariants(episodeEntry.file));
    }
  }
  return [];
}
export function getVideoTranslations(playerData) {
  const translations = playerData && playerData.message && playerData.message.translations && playerData.message.translations.video
    ? playerData.message.translations.video
    : null;
  if (!translations || typeof translations !== 'object') {
    return null;
  }
  return translations;
}

export function decodePlayerjsValue(encodedValue, decodeConfig = defaultDecodeConfig) {
  const source = String(encodedValue || '');
  if (!source.startsWith('#2')) {
    return source;
  }
  let payload = source.slice(2);
  for (let index = 4; index >= 0; index -= 1) {
    const key = `bk${index}`;
    const blockValue = decodeConfig[key];
    if (!blockValue) {
      continue;
    }
    const marker = `${decodeConfig.file3Separator}${encodeUtf8ToBase64(blockValue)}`;
    payload = payload.split(marker).join('');
  }
  return decodeBase64ToUtf8(payload);
}
export function decodePlaylistJson(playlistText, decodeConfig = defaultDecodeConfig) {
  const decodedPlaylistText = decodePlayerjsValue(playlistText, decodeConfig);
  try {
    return JSON.parse(decodedPlaylistText);
  } catch (error) {
    throw new Error(`playlist payload is not JSON: ${error.message}`);
  }
}
export function resolvePlaylistUrlFromPlayerData(playerData, options = {}) {
  const candidates = resolvePlaylistUrlsFromPlayerData(playerData, options);
  return candidates[0];
}
export function resolvePlaylistUrlsFromPlayerData(playerData, options = {}) {
  const translations = getVideoTranslations(playerData);
  if (!translations) {
    throw new Error('player-data does not contain translations.video');
  }
  const entries = Object.entries(translations).filter((entry) => typeof entry[1] === 'string' && entry[1].startsWith('#2'));
  if (!entries.length) {
    throw new Error('player-data does not contain decodable translation entries');
  }
  const ordered = orderTranslationEntries(entries, options.preferredTranslationPattern);
  const resolved = [];
  for (const [translationName, encodedPlaylistUrl] of ordered) {
    const playlistUrl = decodePlayerjsValue(encodedPlaylistUrl, options.decodeConfig || defaultDecodeConfig);
    if (!playlistUrl.startsWith('http')) {
      continue;
    }
    resolved.push({
      translationName,
      playlistUrl
    });
  }
  if (!resolved.length) {
    throw new Error('decoded playlist url is invalid');
  }
  return resolved;
}
export async function fetchDecodedPlaylistJson(playlistUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(playlistUrl, {
    headers: {
      Accept: 'text/plain,application/json,*/*',
      'User-Agent': options.userAgent || 'Mozilla/5.0'
    }
  });
  if (!response.ok) {
    throw new Error(`playlist request failed: HTTP ${response.status}`);
  }
  const playlistText = await response.text();
  return decodePlaylistJson(playlistText, options.decodeConfig || defaultDecodeConfig);
}

export async function resolveEpisodeSourceFromPlayerData(playerData, options = {}) {
  const season = Number.parseInt(String(options.season || ''), 10);
  const episode = Number.parseInt(String(options.episode || ''), 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    throw new Error('season and episode are required integers');
  }
  const candidates = resolvePlaylistUrlsFromPlayerData(playerData, options);
  let lastFetchError = null;
  for (const candidate of candidates) {
    let playlistJson = null;
    try {
      playlistJson = await fetchDecodedPlaylistJson(candidate.playlistUrl, options);
    } catch (error) {
      lastFetchError = error;
      continue;
    }
    const variants = findEpisodeVariants(playlistJson, season, episode);
    const selected = pickVariant(variants, options.preferredQuality || Number.MAX_SAFE_INTEGER);
    if (!selected || !selected.url) {
      continue;
    }
    return {
      sourceUrl: selected.url,
      quality: selected.quality,
      variants,
      playlistUrl: candidate.playlistUrl,
      translationName: candidate.translationName
    };
  }
  if (lastFetchError && candidates.length) {
    throw lastFetchError;
  }
  throw new Error('episode source was not found in decoded playlist');
}

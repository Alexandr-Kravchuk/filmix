const defaultDecodeConfig = Object.freeze({
  file3Separator: ':<:',
  bk0: '2owKDUoGzsuLNEyhNx',
  bk1: '19n1iKBr89ubskS5zT',
  bk2: 'IDaBt08C9Wf7lYr0eH',
  bk3: 'lNjI9V5U1gMnsxt4Qr',
  bk4: 'o9wPt0ii42GWeS7L7A'
});

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

function pickVariant(variants, preferredQuality) {
  if (!variants.length) {
    return null;
  }
  const preferred = Number.parseInt(String(preferredQuality || ''), 10);
  if (Number.isFinite(preferred)) {
    const exact = variants.find((item) => item.quality === preferred);
    if (exact) {
      return exact;
    }
  }
  return [...variants].sort((a, b) => b.quality - a.quality)[0];
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

function pickTranslation(videoTranslations, preferredTranslationPattern) {
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
  const ukrainian = entries.find(([name]) => /ukr|укра/i.test(name));
  if (ukrainian) {
    return ukrainian;
  }
  return entries[0];
}

function findEpisodeSourceUrl(playlistJson, season, episode, preferredQuality) {
  if (!Array.isArray(playlistJson)) {
    return null;
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
      const variants = parseQualityVariants(episodeEntry.file);
      const selected = pickVariant(variants, preferredQuality);
      return selected ? selected.url : null;
    }
  }
  return null;
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

export async function resolveEpisodeSourceFromPlayerData(playerData, options = {}) {
  const season = Number.parseInt(String(options.season || ''), 10);
  const episode = Number.parseInt(String(options.episode || ''), 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    throw new Error('season and episode are required integers');
  }
  const translations = playerData && playerData.message && playerData.message.translations && playerData.message.translations.video
    ? playerData.message.translations.video
    : null;
  if (!translations || typeof translations !== 'object') {
    throw new Error('player-data does not contain translations.video');
  }
  const translation = pickTranslation(translations, options.preferredTranslationPattern);
  if (!translation) {
    throw new Error('player-data does not contain decodable translation entries');
  }
  const [translationName, encodedPlaylistUrl] = translation;
  const playlistUrl = decodePlayerjsValue(encodedPlaylistUrl, options.decodeConfig || defaultDecodeConfig);
  if (!playlistUrl.startsWith('http')) {
    throw new Error('decoded playlist url is invalid');
  }
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
  const decodedPlaylistText = decodePlayerjsValue(playlistText, options.decodeConfig || defaultDecodeConfig);
  let playlistJson;
  try {
    playlistJson = JSON.parse(decodedPlaylistText);
  } catch (error) {
    throw new Error(`playlist payload is not JSON: ${error.message}`);
  }
  const sourceUrl = findEpisodeSourceUrl(playlistJson, season, episode, options.preferredQuality || 480);
  if (!sourceUrl) {
    throw new Error('episode source was not found in decoded playlist');
  }
  return {
    sourceUrl,
    playlistUrl,
    translationName
  };
}


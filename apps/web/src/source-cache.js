const SOURCE_CACHE_KEY = 'filmix-source-cache-v1';
const SOURCE_CACHE_VERSION = 1;
const SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
function normalizeQualityKey(quality) {
  if (quality === undefined || quality === null || String(quality).trim() === '') {
    return 'max';
  }
  const normalized = String(quality).trim().toLowerCase();
  if (normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return 'max';
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'max';
  }
  return String(parsed);
}
export function buildSourceCacheKey(season, episode, quality = 'max') {
  return `${season}:${episode}:${normalizeQualityKey(quality)}`;
}

function getStorage() {
  try {
    if (!('localStorage' in globalThis)) {
      return null;
    }
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
function readRecord(storage) {
  const raw = storage.getItem(SOURCE_CACHE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SOURCE_CACHE_VERSION || !parsed.items || typeof parsed.items !== 'object') {
      storage.removeItem(SOURCE_CACHE_KEY);
      return null;
    }
    return parsed;
  } catch {
    storage.removeItem(SOURCE_CACHE_KEY);
    return null;
  }
}
function writeRecord(storage, record) {
  storage.setItem(SOURCE_CACHE_KEY, JSON.stringify(record));
}
function ensureRecord(storage) {
  const existing = readRecord(storage);
  if (existing) {
    return existing;
  }
  return {
    version: SOURCE_CACHE_VERSION,
    items: {}
  };
}

export function readSourceUrl(episodeKey, now = Date.now()) {
  const storage = getStorage();
  if (!storage) {
    return '';
  }
  const record = readRecord(storage);
  if (!record) {
    return '';
  }
  const item = record.items[episodeKey];
  if (!item || typeof item.sourceUrl !== 'string' || !Number.isFinite(item.savedAt)) {
    delete record.items[episodeKey];
    writeRecord(storage, record);
    return '';
  }
  if (now - item.savedAt > SOURCE_CACHE_TTL_MS) {
    delete record.items[episodeKey];
    writeRecord(storage, record);
    return '';
  }
  return item.sourceUrl;
}
export function writeSourceUrl(episodeKey, sourceUrl, now = Date.now()) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  if (!episodeKey || typeof sourceUrl !== 'string' || !sourceUrl) {
    return;
  }
  const record = ensureRecord(storage);
  record.items[episodeKey] = {
    sourceUrl,
    savedAt: now
  };
  writeRecord(storage, record);
}
export function writeSourceUrls(entries, now = Date.now()) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  const record = ensureRecord(storage);
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !entry.episodeKey || typeof entry.sourceUrl !== 'string' || !entry.sourceUrl) {
      continue;
    }
    record.items[entry.episodeKey] = {
      sourceUrl: entry.sourceUrl,
      savedAt: now
    };
  }
  writeRecord(storage, record);
}

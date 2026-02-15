const SHOW_CACHE_KEY = 'filmix-show-cache-v1';
const SHOW_CACHE_VERSION = 1;
const SHOW_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

function isCachePayloadValid(value) {
  return !!(value && typeof value === 'object' && value.payload && typeof value.payload === 'object');
}

export function readShowCache(now = Date.now()) {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  const raw = storage.getItem(SHOW_CACHE_KEY);
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(SHOW_CACHE_KEY);
    return null;
  }
  if (!parsed || parsed.version !== SHOW_CACHE_VERSION || !Number.isFinite(parsed.savedAt) || !isCachePayloadValid(parsed)) {
    storage.removeItem(SHOW_CACHE_KEY);
    return null;
  }
  if (now - parsed.savedAt > SHOW_CACHE_TTL_MS) {
    storage.removeItem(SHOW_CACHE_KEY);
    return null;
  }
  return parsed.payload;
}

export function writeShowCache(payload, now = Date.now()) {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  if (!payload || typeof payload !== 'object') {
    return;
  }
  const record = {
    version: SHOW_CACHE_VERSION,
    savedAt: now,
    payload
  };
  storage.setItem(SHOW_CACHE_KEY, JSON.stringify(record));
}

export function clearShowCache() {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  storage.removeItem(SHOW_CACHE_KEY);
}

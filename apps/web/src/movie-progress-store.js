const STORAGE_KEY = 'filmix-movie-progress-v1';
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function getStorage() {
  try {
    if (typeof globalThis.localStorage === 'undefined') {
      return null;
    }
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
function normalize(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const url = String(value.url || '').trim();
  if (!url) {
    return null;
  }
  const currentTime = Number(value.currentTime);
  const segmentIndex = Number(value.segmentIndex);
  const segmentSeconds = Number(value.segmentSeconds);
  const segmentCount = Number(value.segmentCount);
  const duration = Number(value.duration);
  const savedAt = Number(value.savedAt);
  return {
    url,
    currentTime: Number.isFinite(currentTime) && currentTime >= 0 ? currentTime : 0,
    segmentIndex: Number.isFinite(segmentIndex) && segmentIndex >= 0 ? Math.floor(segmentIndex) : 0,
    segmentSeconds: Number.isFinite(segmentSeconds) && segmentSeconds > 0 ? Math.floor(segmentSeconds) : 0,
    segmentCount: Number.isFinite(segmentCount) && segmentCount > 0 ? Math.floor(segmentCount) : 0,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    quality: typeof value.quality === 'string' ? value.quality : '',
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now()
  };
}

export function readMovieProgress() {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const normalized = normalize(parsed);
  if (!normalized) {
    return null;
  }
  if (Date.now() - normalized.savedAt > MAX_AGE_MS) {
    clearMovieProgress();
    return null;
  }
  return normalized;
}

export function writeMovieProgress(value) {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  const normalized = normalize({ ...value, savedAt: Date.now() });
  if (!normalized) {
    return null;
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    return null;
  }
  return normalized;
}

export function clearMovieProgress() {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
  }
}

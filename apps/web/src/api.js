const envBase = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.VITE_API_BASE_URL : undefined;
const apiBaseUrl = (envBase || 'http://localhost:3000').replace(/\/$/, '');

export function getApiBaseUrl() {
  return apiBaseUrl;
}

function makeApiUrl(path, params) {
  const url = new URL(`${apiBaseUrl}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function fetchJson(path, params, init = {}) {
  const url = makeApiUrl(path, params);
  const headers = {
    Accept: 'application/json',
    ...(init.headers || {})
  };
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchShow(options = {}) {
  if (options && options.force) {
    return fetchJson('/api/show', { force: 1 });
  }
  return fetchJson('/api/show');
}
export async function fetchSourceByEpisode(season, episode, quality = 'max') {
  return fetchJson('/api/source', { season, episode, quality });
}
export async function fetchSourceBatch(season, episodes, quality = 'max') {
  const normalized = Array.from(new Set((Array.isArray(episodes) ? episodes : [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value) && value > 0)));
  return fetchJson('/api/source-batch', {
    season,
    episodes: normalized.join(','),
    quality
  });
}
export async function fetchSourceLadder(season, episode) {
  return fetchJson('/api/source-ladder', { season, episode });
}
export async function fetchPlaybackProgress() {
  return fetchJson('/api/progress');
}
export async function savePlaybackProgress(payload, options = {}) {
  return fetchJson('/api/progress', undefined, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload || {}),
    keepalive: !!options.keepalive
  });
}
export function sendPlaybackProgressBeacon(payload) {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return false;
  }
  const url = makeApiUrl('/api/progress');
  const body = JSON.stringify(payload || {});
  return navigator.sendBeacon(url.toString(), body);
}

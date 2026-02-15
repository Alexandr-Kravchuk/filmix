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

async function fetchJson(path, params) {
  const url = makeApiUrl(path, params);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchShow() {
  return fetchJson('/api/show');
}
export async function fetchSourceByEpisode(season, episode) {
  return fetchJson('/api/source', { season, episode });
}

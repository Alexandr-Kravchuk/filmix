import { buildEpisodeKey } from './types.js';

function getHeaderValue(headers, key) {
  if (!Array.isArray(headers)) {
    return '';
  }
  const item = headers.find((header) => String(header.name || '').toLowerCase() === key.toLowerCase());
  return item ? String(item.value || '') : '';
}

function isMediaUrl(url, mimeType) {
  const lowerUrl = String(url || '').toLowerCase();
  const lowerMime = String(mimeType || '').toLowerCase();
  if (lowerUrl.includes('.mp4') || lowerUrl.includes('.m3u8') || lowerUrl.includes('.mpd')) {
    return true;
  }
  if (lowerMime.includes('video/') || lowerMime.includes('mpegurl') || lowerMime.includes('dash+xml')) {
    return true;
  }
  return false;
}

function extractSeasonEpisodeFromUrl(url) {
  const match = String(url || '').match(/s(\d{1,2})e(\d{1,2})/i);
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

function hasEnglishMarker(text) {
  const normalized = String(text || '').toLowerCase();
  return /\benglish\b|\beng\b|language[^a-z0-9]*en\b|audio[^a-z0-9]*track[^a-z0-9]*en\b|"en"|\ben-us\b/.test(normalized);
}

function cleanUrl(rawUrl) {
  const url = String(rawUrl || '');
  const index = url.indexOf('#');
  if (index === -1) {
    return url;
  }
  return url.slice(0, index);
}

function scoreCandidate(entry, url, textBlob) {
  let score = 0;
  const normalizedUrl = String(url).toLowerCase();
  if (hasEnglishMarker(textBlob)) {
    score += 8;
  }
  if (normalizedUrl.includes('.m3u8')) {
    score += 3;
  }
  if (normalizedUrl.includes('.mp4')) {
    score += 2;
  }
  if (entry && entry.response && [200, 206].includes(entry.response.status)) {
    score += 1;
  }
  return score;
}

export function parseHarToEnglishMap(harObject, options = {}) {
  const existingMap = options.existingMap || {};
  const output = { ...existingMap };
  const scores = {};
  const entries = harObject && harObject.log && Array.isArray(harObject.log.entries) ? harObject.log.entries : [];
  for (const entry of entries) {
    const request = entry.request || {};
    const response = entry.response || {};
    const url = cleanUrl(request.url || '');
    const mimeType = response.content ? response.content.mimeType : '';
    if (!isMediaUrl(url, mimeType)) {
      continue;
    }
    const seasonEpisode = extractSeasonEpisodeFromUrl(url);
    if (!seasonEpisode) {
      continue;
    }
    const bodyText = request.postData ? request.postData.text : '';
    const responseText = response.content ? response.content.text : '';
    const requestHeaders = Array.isArray(request.headers)
      ? request.headers.map((header) => `${header.name}:${header.value}`).join(';')
      : '';
    const responseHeaders = Array.isArray(response.headers)
      ? response.headers.map((header) => `${header.name}:${header.value}`).join(';')
      : '';
    const contentLanguage = getHeaderValue(response.headers, 'content-language');
    const textBlob = `${url}\n${bodyText}\n${responseText}\n${requestHeaders}\n${responseHeaders}\n${contentLanguage}`;
    if (!hasEnglishMarker(textBlob)) {
      continue;
    }
    const key = buildEpisodeKey(seasonEpisode.season, seasonEpisode.episode);
    const score = scoreCandidate(entry, url, textBlob);
    if (!scores[key] || score > scores[key]) {
      scores[key] = score;
      output[key] = url;
    }
  }
  return output;
}

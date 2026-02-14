export const LanguageCode = Object.freeze({
  EN: 'en',
  UK: 'uk',
  RU: 'ru'
});

export function buildEpisodeKey(season, episode) {
  return `${season}:${episode}`;
}

export function parseSeasonNumber(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

export function parseEpisodeNumber(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/(\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10);
}

export function detectLanguage(name) {
  if (!name) {
    return null;
  }
  const normalized = name.toLowerCase();
  if (normalized.includes('eng') || normalized.includes('english')) {
    return LanguageCode.EN;
  }
  if (normalized.includes('ukr') || normalized.includes('укра')) {
    return LanguageCode.UK;
  }
  if (normalized.includes('[ru') || normalized.includes('russian') || normalized.includes('рус')) {
    return LanguageCode.RU;
  }
  return null;
}

export function pickDefaultLanguage(sources) {
  if (sources[LanguageCode.EN]) {
    return LanguageCode.EN;
  }
  if (sources[LanguageCode.UK]) {
    return LanguageCode.UK;
  }
  if (sources[LanguageCode.RU]) {
    return LanguageCode.RU;
  }
  return null;
}

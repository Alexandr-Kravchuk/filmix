import { buildEpisodeKey, detectLanguage, parseEpisodeNumber, parseSeasonNumber, pickDefaultLanguage } from './types.js';

function scoreQuality(value) {
  const quality = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(quality)) {
    return 0;
  }
  if (quality >= 1080) {
    return 4;
  }
  if (quality >= 720) {
    return 3;
  }
  if (quality >= 480) {
    return 2;
  }
  return 1;
}

function chooseBestSource(variants) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  const normalized = variants
    .map((item) => {
      if (typeof item === 'string') {
        return { url: item, score: 0 };
      }
      if (!item || typeof item !== 'object' || typeof item.url !== 'string') {
        return null;
      }
      return { url: item.url, score: scoreQuality(item.quality) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return normalized.length > 0 ? normalized[0].url : null;
}

export function createCatalog(playerData, options = {}) {
  const showTitle = options.showTitle || 'Filmix Show';
  const englishMap = options.englishMap || {};
  const links = playerData && playerData.message && Array.isArray(playerData.message.links) ? playerData.message.links : [];
  const sourceMap = {};
  const seasons = new Set();
  const episodesBySeason = {};
  for (const translation of links) {
    const translationName = translation ? translation.name : '';
    const lang = detectLanguage(translationName);
    if (!lang) {
      continue;
    }
    const files = translation && translation.files && typeof translation.files === 'object' ? translation.files : {};
    for (const [seasonName, episodes] of Object.entries(files)) {
      const season = parseSeasonNumber(seasonName);
      if (!season || !episodes || typeof episodes !== 'object') {
        continue;
      }
      seasons.add(season);
      if (!episodesBySeason[season]) {
        episodesBySeason[season] = new Set();
      }
      for (const [episodeName, variants] of Object.entries(episodes)) {
        const episode = parseEpisodeNumber(episodeName);
        if (!episode) {
          continue;
        }
        const url = chooseBestSource(variants);
        if (!url) {
          continue;
        }
        episodesBySeason[season].add(episode);
        const key = buildEpisodeKey(season, episode);
        if (!sourceMap[key]) {
          sourceMap[key] = {};
        }
        sourceMap[key][lang] = url;
      }
    }
  }
  for (const [key, url] of Object.entries(englishMap)) {
    if (typeof url !== 'string' || !url.startsWith('http')) {
      continue;
    }
    if (!sourceMap[key]) {
      sourceMap[key] = {};
    }
    sourceMap[key].en = url;
    const [seasonPart, episodePart] = key.split(':').map(Number);
    if (Number.isFinite(seasonPart) && Number.isFinite(episodePart)) {
      seasons.add(seasonPart);
      if (!episodesBySeason[seasonPart]) {
        episodesBySeason[seasonPart] = new Set();
      }
      episodesBySeason[seasonPart].add(episodePart);
    }
  }
  const sortedSeasons = Array.from(seasons).sort((a, b) => a - b);
  const normalizedEpisodesBySeason = {};
  for (const season of sortedSeasons) {
    const episodes = episodesBySeason[season] ? Array.from(episodesBySeason[season]).sort((a, b) => a - b) : [];
    normalizedEpisodesBySeason[season] = episodes;
  }
  const availableLanguagesSet = new Set();
  for (const value of Object.values(sourceMap)) {
    for (const lang of Object.keys(value)) {
      availableLanguagesSet.add(lang);
    }
  }
  const languageOrder = ['en', 'uk', 'ru'];
  const languagesAvailable = languageOrder.filter((lang) => availableLanguagesSet.has(lang));
  return {
    title: showTitle,
    seasons: sortedSeasons,
    episodesBySeason: normalizedEpisodesBySeason,
    sourceMap,
    languagesAvailable
  };
}

export function getEpisodeData(catalog, season, episode) {
  const key = buildEpisodeKey(season, episode);
  const sourcesByLang = catalog.sourceMap[key] || {};
  const sourceList = [];
  const labels = {
    en: 'English',
    uk: 'Ukrainian',
    ru: 'Russian'
  };
  for (const lang of ['en', 'uk', 'ru']) {
    if (!sourcesByLang[lang]) {
      continue;
    }
    sourceList.push({
      lang,
      label: labels[lang],
      sourceUrl: sourcesByLang[lang]
    });
  }
  return {
    season,
    episode,
    sources: sourceList,
    defaultLang: pickDefaultLanguage(sourcesByLang)
  };
}

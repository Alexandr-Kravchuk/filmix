function toSortedNumbers(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
}
function normalizeCatalog(payload) {
  const seasonMap = {};
  const seasonsFromMap = [];
  const episodesBySeason = payload && payload.episodesBySeason && typeof payload.episodesBySeason === 'object' ? payload.episodesBySeason : {};
  for (const [seasonRaw, episodesRaw] of Object.entries(episodesBySeason)) {
    const season = Number.parseInt(String(seasonRaw), 10);
    if (!Number.isFinite(season)) {
      continue;
    }
    const episodes = toSortedNumbers(episodesRaw);
    if (!episodes.length) {
      continue;
    }
    seasonMap[season] = episodes;
    seasonsFromMap.push(season);
  }
  const seasons = toSortedNumbers([...(payload && Array.isArray(payload.seasons) ? payload.seasons : []), ...seasonsFromMap]);
  return {
    title: payload && payload.title ? String(payload.title) : 'Filmix English Player',
    seasons,
    episodesBySeason: seasonMap,
    fixed: payload && payload.fixed && Number.isFinite(Number(payload.fixed.season)) && Number.isFinite(Number(payload.fixed.episode))
      ? {
          season: Number.parseInt(String(payload.fixed.season), 10),
          episode: Number.parseInt(String(payload.fixed.episode), 10)
        }
      : null
  };
}
function buildFingerprint(catalog) {
  return JSON.stringify({
    title: catalog.title,
    seasons: catalog.seasons,
    episodesBySeason: catalog.episodesBySeason,
    fixed: catalog.fixed
  });
}

export function createCatalogController(options) {
  const state = {
    catalog: null,
    fingerprint: '',
    current: { season: 0, episode: 0 }
  };
  function getEpisodes(season, catalog = state.catalog) {
    return catalog && catalog.episodesBySeason[season] ? catalog.episodesBySeason[season] : [];
  }
  function resolveEpisodeSelection(catalog, preferredEpisode) {
    if (preferredEpisode && Number.isFinite(preferredEpisode.season) && Number.isFinite(preferredEpisode.episode)) {
      const preferredEpisodes = getEpisodes(preferredEpisode.season, catalog);
      if (preferredEpisodes.includes(preferredEpisode.episode)) {
        return { season: preferredEpisode.season, episode: preferredEpisode.episode };
      }
    }
    if (catalog.fixed) {
      const fixedEpisodes = getEpisodes(catalog.fixed.season, catalog);
      if (fixedEpisodes.includes(catalog.fixed.episode)) {
        return { season: catalog.fixed.season, episode: catalog.fixed.episode };
      }
    }
    for (const season of catalog.seasons) {
      const episodes = getEpisodes(season, catalog);
      if (episodes.length) {
        return { season, episode: episodes[0] };
      }
    }
    return null;
  }
  function renderSeasonOptions(selectedSeason) {
    options.elements.seasonSelect.innerHTML = '';
    for (const season of state.catalog.seasons) {
      const option = document.createElement('option');
      option.value = String(season);
      option.textContent = `Season ${season}`;
      options.elements.seasonSelect.append(option);
    }
    options.elements.seasonSelect.value = String(selectedSeason);
  }
  function renderEpisodeOptions(season, selectedEpisode) {
    const episodes = getEpisodes(season);
    options.elements.episodeSelect.innerHTML = '';
    for (const episode of episodes) {
      const option = document.createElement('option');
      option.value = String(episode);
      option.textContent = `Episode ${episode}`;
      options.elements.episodeSelect.append(option);
    }
    options.elements.episodeSelect.value = String(selectedEpisode);
  }
  function getNextEpisode(season, episode) {
    if (!state.catalog || !state.catalog.seasons.length) {
      return null;
    }
    const seasonIndex = state.catalog.seasons.indexOf(season);
    if (seasonIndex < 0) {
      return null;
    }
    const episodes = getEpisodes(season);
    const episodeIndex = episodes.indexOf(episode);
    if (episodeIndex >= 0 && episodeIndex + 1 < episodes.length) {
      return { season, episode: episodes[episodeIndex + 1] };
    }
    for (let index = seasonIndex + 1; index < state.catalog.seasons.length; index += 1) {
      const nextSeason = state.catalog.seasons[index];
      const nextEpisodes = getEpisodes(nextSeason);
      if (nextEpisodes.length) {
        return { season: nextSeason, episode: nextEpisodes[0] };
      }
    }
    return null;
  }
  function notifyWindowChanged() {
    if (typeof options.onWindowChanged !== 'function') {
      return;
    }
    const current = Number.isFinite(state.current.season) && Number.isFinite(state.current.episode) ? { ...state.current } : null;
    const next = current ? getNextEpisode(current.season, current.episode) : null;
    options.onWindowChanged(current, next);
  }
  function setCurrentEpisode(season, episode, syncControls = true) {
    state.current = { season, episode };
    if (syncControls) {
      options.elements.seasonSelect.value = String(season);
      renderEpisodeOptions(season, episode);
      options.elements.episodeSelect.value = String(episode);
    }
    notifyWindowChanged();
  }
  function applyCatalogPayload(payload, args = {}) {
    const preserveSelection = args.preserveSelection !== false;
    const preferredEpisode = args.preferredEpisode || (preserveSelection ? { ...state.current } : null);
    const nextCatalog = normalizeCatalog(payload);
    const nextFingerprint = buildFingerprint(nextCatalog);
    if (state.catalog && nextFingerprint === state.fingerprint) {
      return {
        changed: false,
        selected: { ...state.current }
      };
    }
    const selected = resolveEpisodeSelection(nextCatalog, preferredEpisode);
    if (!selected) {
      throw new Error('No episodes available in catalog');
    }
    state.catalog = nextCatalog;
    state.fingerprint = nextFingerprint;
    options.elements.showTitle.textContent = `${state.catalog.title} English Player`;
    renderSeasonOptions(selected.season);
    renderEpisodeOptions(selected.season, selected.episode);
    setCurrentEpisode(selected.season, selected.episode, false);
    options.elements.seasonSelect.value = String(selected.season);
    options.elements.episodeSelect.value = String(selected.episode);
    return {
      changed: true,
      selected
    };
  }
  function getSelectedEpisodeFromControls() {
    const season = Number.parseInt(String(options.elements.seasonSelect.value || ''), 10);
    const episode = Number.parseInt(String(options.elements.episodeSelect.value || ''), 10);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return null;
    }
    return { season, episode };
  }
  function selectEpisodeBySeason(season, preferredEpisode) {
    const episodes = getEpisodes(season);
    if (!episodes.length) {
      return null;
    }
    const episode = episodes.includes(preferredEpisode) ? preferredEpisode : episodes[0];
    renderEpisodeOptions(season, episode);
    setCurrentEpisode(season, episode, false);
    return { season, episode };
  }
  function handleSeasonChange() {
    const season = Number.parseInt(String(options.elements.seasonSelect.value || ''), 10);
    if (!Number.isFinite(season)) {
      return;
    }
    const selected = selectEpisodeBySeason(season, state.current.episode);
    if (!selected) {
      return;
    }
    options.elements.episodeSelect.value = String(selected.episode);
    options.setStatus(`Selected Season ${selected.season}, episode ${selected.episode}`);
    if (typeof options.setBackgroundStatus === 'function') {
      options.setBackgroundStatus('');
    }
    options.setProgress(0);
    options.setProgressText('');
  }
  function handleEpisodeChange() {
    const selected = getSelectedEpisodeFromControls();
    if (!selected) {
      return;
    }
    setCurrentEpisode(selected.season, selected.episode, false);
    options.setStatus(`Selected Season ${selected.season}, episode ${selected.episode}`);
    if (typeof options.setBackgroundStatus === 'function') {
      options.setBackgroundStatus('');
    }
    options.setProgress(0);
    options.setProgressText('');
  }
  async function refreshCatalog(args = {}) {
    const force = !!args.force;
    const foreground = !!args.foreground;
    const silentError = !!args.silentError;
    const preserveSelection = args.preserveSelection !== false;
    const preferredEpisode = preserveSelection ? { ...state.current } : null;
    if (foreground) {
      options.setBusy(true);
      options.setStatus(force ? 'Refreshing episodes...' : 'Loading episodes...');
    }
    try {
      const payload = await options.fetchShow({ force });
      options.writeShowCache(payload);
      const result = applyCatalogPayload(payload, {
        preserveSelection,
        preferredEpisode
      });
      if (foreground) {
        if (force) {
          options.setStatus('Episodes refreshed');
        } else {
          options.setStatus(`Selected Season ${state.current.season}, episode ${state.current.episode}. Press Play.`);
        }
        if (typeof options.setBackgroundStatus === 'function') {
          options.setBackgroundStatus('');
        }
      } else if (result.changed) {
        options.setStatus(`Episodes updated. Selected Season ${state.current.season}, episode ${state.current.episode}.`);
      }
      return result;
    } catch (error) {
      if (!silentError) {
        const message = error && error.message ? error.message : 'Cannot load show catalog';
        options.setStatus(message, true);
      }
      throw error;
    } finally {
      if (foreground) {
        options.setBusy(false);
      }
    }
  }
  function tryLoadCatalogFromCache() {
    const payload = options.readShowCache();
    if (!payload) {
      return false;
    }
    try {
      applyCatalogPayload(payload, {
        preserveSelection: false
      });
      options.setStatus('Loaded from cache. Refreshing episodes...');
      return true;
    } catch {
      options.clearShowCache();
      return false;
    }
  }
  return {
    getCatalog() {
      return state.catalog;
    },
    getCurrentEpisode() {
      return { ...state.current };
    },
    getEpisodes,
    getNextEpisode,
    setCurrentEpisode,
    getSelectedEpisodeFromControls,
    refreshCatalog,
    tryLoadCatalogFromCache,
    handleSeasonChange,
    handleEpisodeChange
  };
}

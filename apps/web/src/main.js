import './styles.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { fetchShow, fetchSourceByEpisode, getApiBaseUrl } from './api.js';

const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const OUTPUT_CACHE_NAME = 'filmix-en-track-cache-v1';

const elements = {
  showTitle: document.getElementById('show-title'),
  status: document.getElementById('status'),
  seasonSelect: document.getElementById('season-select'),
  episodeSelect: document.getElementById('episode-select'),
  playButton: document.getElementById('play-btn'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  video: document.getElementById('video')
};

const state = {
  catalog: null,
  current: { season: 0, episode: 0 },
  prepared: new Map(),
  tasks: new Map(),
  coreAssetPromise: null,
  isBusy: false,
  playRequestId: 0
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(isBusy) {
  state.isBusy = isBusy;
  elements.seasonSelect.disabled = isBusy;
  elements.episodeSelect.disabled = isBusy;
  elements.playButton.disabled = isBusy || !state.catalog;
  if (!isBusy) {
    elements.playButton.textContent = 'Play';
  }
}

function setProgress(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  elements.progress.value = normalized;
}

function setProgressText(message) {
  elements.progressText.textContent = message;
}

function buildEpisodeKey(season, episode) {
  return `${season}:${episode}`;
}

function formatEpisodeLabel(season, episode) {
  return `Season ${season}, episode ${episode}`;
}

function toSortedNumbers(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((value) => Number.parseInt(String(value), 10)).filter((value) => Number.isFinite(value)))).sort((a, b) => a - b);
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

function getEpisodes(season) {
  return state.catalog && state.catalog.episodesBySeason[season] ? state.catalog.episodesBySeason[season] : [];
}

function findInitialEpisode() {
  if (!state.catalog || !state.catalog.seasons.length) {
    return null;
  }
  if (state.catalog.fixed) {
    const episodes = getEpisodes(state.catalog.fixed.season);
    if (episodes.includes(state.catalog.fixed.episode)) {
      return {
        season: state.catalog.fixed.season,
        episode: state.catalog.fixed.episode
      };
    }
  }
  const season = state.catalog.seasons[0];
  const episodes = getEpisodes(season);
  if (!episodes.length) {
    return null;
  }
  return { season, episode: episodes[0] };
}

function renderSeasonOptions(selectedSeason) {
  elements.seasonSelect.innerHTML = '';
  for (const season of state.catalog.seasons) {
    const option = document.createElement('option');
    option.value = String(season);
    option.textContent = `Season ${season}`;
    elements.seasonSelect.append(option);
  }
  elements.seasonSelect.value = String(selectedSeason);
}

function renderEpisodeOptions(season, selectedEpisode) {
  const episodes = getEpisodes(season);
  elements.episodeSelect.innerHTML = '';
  for (const episode of episodes) {
    const option = document.createElement('option');
    option.value = String(episode);
    option.textContent = `Episode ${episode}`;
    elements.episodeSelect.append(option);
  }
  elements.episodeSelect.value = String(selectedEpisode);
}

function setCurrentEpisode(season, episode, syncControls = true) {
  state.current = { season, episode };
  if (syncControls) {
    elements.seasonSelect.value = String(season);
    renderEpisodeOptions(season, episode);
    elements.episodeSelect.value = String(episode);
  }
  trimPreparedEntries();
}

function getSelectedEpisode() {
  const season = Number.parseInt(String(elements.seasonSelect.value || ''), 10);
  const episode = Number.parseInt(String(elements.episodeSelect.value || ''), 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { season, episode };
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

function trimPreparedEntries() {
  const keep = new Set();
  if (Number.isFinite(state.current.season) && Number.isFinite(state.current.episode)) {
    keep.add(buildEpisodeKey(state.current.season, state.current.episode));
    const next = getNextEpisode(state.current.season, state.current.episode);
    if (next) {
      keep.add(buildEpisodeKey(next.season, next.episode));
    }
  }
  for (const [key, value] of state.prepared.entries()) {
    if (!keep.has(key)) {
      URL.revokeObjectURL(value.blobUrl);
      state.prepared.delete(key);
    }
  }
}

function concatChunks(chunks, totalLength) {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function getCoreAssets() {
  if (!state.coreAssetPromise) {
    state.coreAssetPromise = Promise.all([
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
    ]).then(([coreURL, wasmURL]) => ({ coreURL, wasmURL }));
  }
  return state.coreAssetPromise;
}

function getCacheKey(sourceUrl) {
  return `https://filmix-cache.local/en-track/${encodeURIComponent(sourceUrl)}`;
}

async function loadCachedOutput(sourceUrl) {
  if (!('caches' in globalThis)) {
    return null;
  }
  const cache = await caches.open(OUTPUT_CACHE_NAME);
  const response = await cache.match(getCacheKey(sourceUrl));
  if (!response) {
    return null;
  }
  const bytes = await response.arrayBuffer();
  return new Uint8Array(bytes);
}

async function saveCachedOutput(sourceUrl, bytes) {
  if (!('caches' in globalThis)) {
    return;
  }
  const cache = await caches.open(OUTPUT_CACHE_NAME);
  await cache.put(
    getCacheKey(sourceUrl),
    new Response(new Blob([bytes], { type: 'video/mp4' }), {
      headers: {
        'Content-Type': 'video/mp4'
      }
    })
  );
}

async function downloadSourceFile(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
    throw new Error(`Source URL is invalid or expired: expected video, got ${contentType}`);
  }
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(total) && total > MAX_SOURCE_BYTES) {
    throw new Error(`Source is too large (${Math.round(total / (1024 * 1024))}MB) for frontend processing`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let chunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      received += value.length;
      chunkCount += 1;
      if (total > 0) {
        onProgress(Math.min(0.99, received / total));
      } else {
        onProgress(Math.min(0.85, 0.08 + chunkCount * 0.03));
      }
      if (received > MAX_SOURCE_BYTES) {
        throw new Error(`Downloaded stream exceeded ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB limit`);
      }
    }
  }
  if (received === 0) {
    throw new Error('Source URL returned empty response body');
  }
  return concatChunks(chunks, received);
}

function createFfmpegSession(onProgress) {
  const ffmpeg = new FFmpeg();
  let lastError = '';
  const logTail = [];
  const onLog = ({ type, message }) => {
    const text = String(message || '').trim();
    if (text) {
      logTail.push(text);
      if (logTail.length > 50) {
        logTail.shift();
      }
    }
    if (type === 'fferr') {
      lastError = text;
    }
  };
  const onProgressChange = ({ progress }) => {
    onProgress(Math.max(0, Math.min(1, Number(progress) || 0)));
  };
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgressChange);
  return {
    ffmpeg,
    getLastError() {
      return lastError;
    },
    getDebugLog() {
      return logTail.join(' | ');
    },
    dispose() {
      try {
        ffmpeg.off('log', onLog);
        ffmpeg.off('progress', onProgressChange);
      } catch {
      }
      try {
        ffmpeg.terminate();
      } catch {
      }
    }
  };
}

async function remuxEnglishAudio(ffmpeg, getLastError, getDebugLog) {
  const code = await ffmpeg.exec([
    '-y',
    '-i',
    'input.mp4',
    '-map',
    '0:v:0',
    '-map',
    '0:a:m:language:eng',
    '-c',
    'copy',
    '-movflags',
    'faststart',
    'output.mp4'
  ]);
  if (code !== 0) {
    const details = getLastError() || getDebugLog() || `ffmpeg exit code ${code}`;
    throw new Error(`English track is not available in this source. ${details}`);
  }
  return await ffmpeg.readFile('output.mp4');
}

async function cleanupSessionFiles(ffmpeg) {
  for (const fileName of ['input.mp4', 'output.mp4']) {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
    }
  }
}

async function buildEnglishTrack(sourceBytes, onProgress) {
  const session = createFfmpegSession((progress) => onProgress(0.2 + progress * 0.8));
  try {
    const { coreURL, wasmURL } = await getCoreAssets();
    onProgress(0.05);
    await session.ffmpeg.load({ coreURL, wasmURL });
    onProgress(0.15);
    await session.ffmpeg.writeFile('input.mp4', sourceBytes);
    return await remuxEnglishAudio(session.ffmpeg, session.getLastError, session.getDebugLog);
  } finally {
    await cleanupSessionFiles(session.ffmpeg);
    session.dispose();
  }
}

function resolveSourceUrl(value) {
  const sourceUrl = String(value || '').trim();
  if (!sourceUrl) {
    throw new Error('Backend returned empty source URL');
  }
  if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
    return sourceUrl;
  }
  return new URL(sourceUrl, getApiBaseUrl()).toString();
}

function upsertPreparedEntry(season, episode, sourceUrl, outputBytes) {
  const key = buildEpisodeKey(season, episode);
  const oldEntry = state.prepared.get(key);
  if (oldEntry) {
    URL.revokeObjectURL(oldEntry.blobUrl);
  }
  const blobUrl = URL.createObjectURL(new Blob([outputBytes], { type: 'video/mp4' }));
  const entry = { key, season, episode, sourceUrl, blobUrl };
  state.prepared.set(key, entry);
  trimPreparedEntries();
  return entry;
}

function createTask(season, episode) {
  const key = buildEpisodeKey(season, episode);
  const existing = state.tasks.get(key);
  if (existing) {
    return existing;
  }
  const task = {
    key,
    season,
    episode,
    startedAt: Date.now(),
    progress: 0,
    promise: null
  };
  const setTaskProgress = (value) => {
    const normalized = Math.max(0, Math.min(1, Number(value) || 0));
    task.progress = Math.max(task.progress, normalized);
  };
  task.promise = (async () => {
    if (state.prepared.has(key)) {
      task.progress = 1;
      return state.prepared.get(key);
    }
    setTaskProgress(0.02);
    const payload = await fetchSourceByEpisode(season, episode);
    const sourceUrl = resolveSourceUrl(payload.sourceUrl);
    let outputBytes = await loadCachedOutput(sourceUrl);
    if (outputBytes) {
      setTaskProgress(0.98);
    } else {
      const sourceBytes = await downloadSourceFile(sourceUrl, (downloadProgress) => setTaskProgress(0.05 + downloadProgress * 0.5));
      outputBytes = await buildEnglishTrack(sourceBytes, (ffmpegProgress) => setTaskProgress(0.6 + ffmpegProgress * 0.38));
      await saveCachedOutput(sourceUrl, outputBytes);
    }
    setTaskProgress(1);
    return upsertPreparedEntry(season, episode, sourceUrl, outputBytes);
  })().finally(() => {
    state.tasks.delete(key);
  });
  state.tasks.set(key, task);
  return task;
}

function formatEta(task) {
  const progress = Math.max(0, Math.min(1, Number(task.progress) || 0));
  if (progress < 0.03) {
    return 'calculating...';
  }
  const elapsedSeconds = (Date.now() - task.startedAt) / 1000;
  const remaining = Math.max(1, Math.round((elapsedSeconds * (1 - progress)) / progress));
  return `${remaining}s`;
}

function renderForegroundProgress(task) {
  const percent = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
  const eta = formatEta(task);
  setProgress(task.progress);
  setProgressText(`${percent}% • ETA ${eta}`);
  elements.playButton.textContent = `Preparing... ${eta}`;
}

async function prepareEpisodeForeground(season, episode, requestId) {
  const key = buildEpisodeKey(season, episode);
  if (state.prepared.has(key)) {
    setProgress(1);
    setProgressText('100% • Ready');
    return state.prepared.get(key);
  }
  const task = createTask(season, episode);
  setBusy(true);
  renderForegroundProgress(task);
  const timer = globalThis.setInterval(() => {
    if (requestId !== state.playRequestId) {
      return;
    }
    renderForegroundProgress(task);
  }, 250);
  try {
    const entry = await task.promise;
    if (requestId === state.playRequestId) {
      setProgress(1);
      setProgressText('100% • Ready');
    }
    return entry;
  } finally {
    globalThis.clearInterval(timer);
    setBusy(false);
  }
}

async function startPlayback(entry, isAutoStart) {
  const activeSrc = String(elements.video.currentSrc || elements.video.src || '');
  if (activeSrc !== entry.blobUrl) {
    elements.video.src = entry.blobUrl;
    elements.video.load();
  }
  try {
    await elements.video.play();
    setStatus(`Playing ${formatEpisodeLabel(entry.season, entry.episode)} (English)`);
  } catch {
    if (isAutoStart) {
      setStatus(`Autoplay blocked for ${formatEpisodeLabel(entry.season, entry.episode)}. Click Play.`, true);
    } else {
      setStatus(`Playback blocked for ${formatEpisodeLabel(entry.season, entry.episode)}. Click Play again.`, true);
    }
  }
}

function preloadNextEpisode(season, episode) {
  const next = getNextEpisode(season, episode);
  if (!next) {
    return;
  }
  const nextKey = buildEpisodeKey(next.season, next.episode);
  if (state.prepared.has(nextKey) || state.tasks.has(nextKey)) {
    return;
  }
  const task = createTask(next.season, next.episode);
  task.promise.then(() => {
    trimPreparedEntries();
  }).catch(() => {
  });
}

async function playSelectedEpisode(isAutoStart = false) {
  const selected = getSelectedEpisode();
  if (!selected) {
    setStatus('Select season and episode first', true);
    return;
  }
  setCurrentEpisode(selected.season, selected.episode, false);
  const requestId = state.playRequestId + 1;
  state.playRequestId = requestId;
  try {
    const entry = await prepareEpisodeForeground(selected.season, selected.episode, requestId);
    if (requestId !== state.playRequestId) {
      return;
    }
    await startPlayback(entry, isAutoStart);
    preloadNextEpisode(entry.season, entry.episode);
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot prepare video';
    setStatus(message, true);
    setProgress(0);
    setProgressText('');
  }
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

function onSeasonChange() {
  const season = Number.parseInt(String(elements.seasonSelect.value || ''), 10);
  if (!Number.isFinite(season)) {
    return;
  }
  const selected = selectEpisodeBySeason(season, state.current.episode);
  if (!selected) {
    return;
  }
  elements.episodeSelect.value = String(selected.episode);
  setStatus(`Selected ${formatEpisodeLabel(selected.season, selected.episode)}`);
  setProgress(0);
  setProgressText('');
}

function onEpisodeChange() {
  const selected = getSelectedEpisode();
  if (!selected) {
    return;
  }
  setCurrentEpisode(selected.season, selected.episode, false);
  setStatus(`Selected ${formatEpisodeLabel(selected.season, selected.episode)}`);
  setProgress(0);
  setProgressText('');
}

async function onVideoEnded() {
  const next = getNextEpisode(state.current.season, state.current.episode);
  if (!next) {
    setStatus('Last available episode finished');
    return;
  }
  setCurrentEpisode(next.season, next.episode, true);
  setStatus(`Auto-playing ${formatEpisodeLabel(next.season, next.episode)}`);
  await playSelectedEpisode(true);
}

async function init() {
  setBusy(true);
  setProgress(0);
  setProgressText('');
  setStatus('Loading episodes...');
  try {
    const payload = await fetchShow();
    state.catalog = normalizeCatalog(payload);
    elements.showTitle.textContent = `${state.catalog.title} English Player`;
    const initial = findInitialEpisode();
    if (!initial) {
      throw new Error('No episodes available in catalog');
    }
    renderSeasonOptions(initial.season);
    renderEpisodeOptions(initial.season, initial.episode);
    setCurrentEpisode(initial.season, initial.episode, false);
    elements.seasonSelect.value = String(initial.season);
    elements.episodeSelect.value = String(initial.episode);
    setStatus(`Selected ${formatEpisodeLabel(initial.season, initial.episode)}. Press Play.`);
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot load show catalog';
    setStatus(message, true);
  } finally {
    setBusy(false);
  }
}

elements.seasonSelect.addEventListener('change', onSeasonChange);
elements.episodeSelect.addEventListener('change', onEpisodeChange);
elements.playButton.addEventListener('click', () => {
  void playSelectedEpisode(false);
});
elements.video.addEventListener('ended', () => {
  void onVideoEnded();
});

void init();

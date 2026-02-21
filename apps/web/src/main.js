import './styles.css';
import { fetchShow, fetchSourceByEpisode, fetchSourceBatch, fetchPlaybackProgress, savePlaybackProgress, sendPlaybackProgressBeacon, getApiBaseUrl } from './api.js';
import { readShowCache, writeShowCache, clearShowCache } from './show-cache.js';
import { createCatalogController } from './catalog-controller.js';
import { createTaskQueue } from './task-queue.js';
import { createProgressSyncController } from './progress-sync.js';
import { createPlaybackController } from './playback-controller.js';

function parseBooleanEnv(value, fallback = true) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}
function parseBootstrapQuality(value) {
  const parsed = Number.parseInt(String(value || '480'), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 480;
  }
  return parsed;
}
const PLAYBACK_MODE_KEY = 'filmix-playback-mode-v1';
const PLAYBACK_MODE_STANDARD = 'standard';
const PLAYBACK_MODE_MINIMAL = 'minimal';
const MINIMAL_BOOTSTRAP_QUALITY = 1;
function parsePlaybackMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === PLAYBACK_MODE_STANDARD) {
    return PLAYBACK_MODE_STANDARD;
  }
  if (normalized === PLAYBACK_MODE_MINIMAL || normalized === 'min' || normalized === 'low') {
    return PLAYBACK_MODE_MINIMAL;
  }
  return '';
}
function readStoredPlaybackMode() {
  try {
    if (!('localStorage' in globalThis)) {
      return '';
    }
    return parsePlaybackMode(globalThis.localStorage.getItem(PLAYBACK_MODE_KEY));
  } catch {
    return '';
  }
}
function writeStoredPlaybackMode(mode) {
  try {
    if (!('localStorage' in globalThis)) {
      return;
    }
    globalThis.localStorage.setItem(PLAYBACK_MODE_KEY, mode);
  } catch {
  }
}
function readPlaybackModeFromQuery() {
  try {
    const mode = new URL(globalThis.location.href).searchParams.get('mode');
    return parsePlaybackMode(mode);
  } catch {
    return '';
  }
}
function isXboxDevice() {
  if (typeof navigator === 'undefined') {
    return false;
  }
  const userAgent = String(navigator.userAgent || '');
  return userAgent.toLowerCase().includes('xbox');
}
function resolveInitialPlaybackMode() {
  if (xboxSafeMode) {
    return PLAYBACK_MODE_MINIMAL;
  }
  const queryMode = readPlaybackModeFromQuery();
  if (queryMode) {
    return queryMode;
  }
  const storedMode = readStoredPlaybackMode();
  if (storedMode) {
    return storedMode;
  }
  if (isXboxDevice()) {
    return PLAYBACK_MODE_MINIMAL;
  }
  return PLAYBACK_MODE_STANDARD;
}

const bootstrapQuality = parseBootstrapQuality(import.meta.env.VITE_BOOTSTRAP_QUALITY);
const enableHdUpgrade = parseBooleanEnv(import.meta.env.VITE_ENABLE_HD_UPGRADE, true);
const xboxSafeMode = isXboxDevice();
const initialPlaybackMode = resolveInitialPlaybackMode();
const elements = {
  showTitle: document.getElementById('show-title'),
  status: document.getElementById('status'),
  backgroundStatus: document.getElementById('background-status'),
  seasonSelect: document.getElementById('season-select'),
  episodeSelect: document.getElementById('episode-select'),
  playButton: document.getElementById('play-btn'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  video: document.getElementById('video'),
  modeToggleButton: document.getElementById('mode-toggle-btn'),
  refreshEpisodesButton: document.getElementById('refresh-episodes-btn')
};
const state = {
  isBusy: false,
  qualityStage: 'idle',
  playbackMode: initialPlaybackMode
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}
function setBackgroundStatus(message, isError = false) {
  elements.backgroundStatus.textContent = message;
  elements.backgroundStatus.classList.toggle('error', isError);
}
function setProgress(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  elements.progress.value = normalized;
}
function setProgressText(message) {
  elements.progressText.textContent = message;
}
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
function formatEpisodeLabel(season, episode) {
  return `Season ${season}, episode ${episode}`;
}
function getBootstrapQualityForMode() {
  if (xboxSafeMode) {
    return MINIMAL_BOOTSTRAP_QUALITY;
  }
  if (state.playbackMode === PLAYBACK_MODE_MINIMAL) {
    return MINIMAL_BOOTSTRAP_QUALITY;
  }
  return bootstrapQuality;
}
function isHdUpgradeEnabledForMode() {
  if (xboxSafeMode) {
    return false;
  }
  if (state.playbackMode === PLAYBACK_MODE_MINIMAL) {
    return false;
  }
  return enableHdUpgrade;
}
function canRunBackgroundTasks() {
  if (xboxSafeMode) {
    return false;
  }
  return state.playbackMode === PLAYBACK_MODE_STANDARD;
}
function getModeHintText() {
  if (xboxSafeMode) {
    return 'Xbox safe mode: lowest quality, no background tasks';
  }
  if (state.playbackMode === PLAYBACK_MODE_MINIMAL) {
    return 'Minimal mode: lowest quality only';
  }
  if (enableHdUpgrade) {
    return `Two-stage mode: ${bootstrapQuality}p -> max`;
  }
  return 'Single-stage mode: max only';
}
function getRequestedQualityLabel(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 1) {
    return 'lowest quality';
  }
  return `${parsed}p`;
}
function updateModeToggleLabel() {
  if (xboxSafeMode) {
    elements.modeToggleButton.textContent = 'Minimal quality mode: locked (Xbox)';
    return;
  }
  elements.modeToggleButton.textContent = state.playbackMode === PLAYBACK_MODE_MINIMAL
    ? 'Minimal quality mode: on'
    : 'Minimal quality mode: off';
}
function applyPlaybackMode(mode, options = {}) {
  const parsed = xboxSafeMode ? PLAYBACK_MODE_MINIMAL : parsePlaybackMode(mode);
  if (!parsed) {
    return;
  }
  const persist = options.persist !== false;
  const showStatus = options.showStatus === true;
  state.playbackMode = parsed;
  updateModeToggleLabel();
  setBackgroundStatus(getModeHintText());
  if (showStatus) {
    setStatus(parsed === PLAYBACK_MODE_MINIMAL ? 'Minimal quality mode enabled' : 'Standard quality mode enabled');
  }
  setProgress(0);
  setProgressText('');
  if (persist) {
    writeStoredPlaybackMode(parsed);
  }
}
function setBusy(isBusy) {
  state.isBusy = isBusy;
  elements.seasonSelect.disabled = isBusy;
  elements.episodeSelect.disabled = isBusy;
  elements.playButton.disabled = isBusy || !catalog.getCatalog();
  elements.modeToggleButton.disabled = isBusy || xboxSafeMode;
  elements.refreshEpisodesButton.disabled = isBusy;
  if (!isBusy) {
    elements.playButton.textContent = 'Play';
  }
}
function setQualityStage(stage) {
  state.qualityStage = stage;
}
function scheduleFfmpegWarmup() {
  if (xboxSafeMode) {
    return;
  }
  const run = () => {
    taskQueue.warmup();
  };
  if (typeof globalThis.requestIdleCallback === 'function') {
    globalThis.requestIdleCallback(run, { timeout: 2000 });
    return;
  }
  globalThis.setTimeout(run, 0);
}

const taskQueue = createTaskQueue({
  fetchSourceByEpisode,
  fetchSourceBatch,
  getApiBaseUrl,
  bootstrapQuality,
  enableOutputCache: !xboxSafeMode
});
const catalog = createCatalogController({
  elements,
  fetchShow,
  readShowCache,
  writeShowCache,
  clearShowCache,
  setStatus,
  setBackgroundStatus,
  setBusy,
  setProgress,
  setProgressText,
  onWindowChanged(current, next) {
    taskQueue.trimPreparedEntries(current, next);
  }
});
const progressSync = createProgressSyncController({
  video: elements.video,
  getCurrentEpisode: () => catalog.getCurrentEpisode(),
  getEpisodes: (season) => catalog.getEpisodes(season),
  setCurrentEpisode: (season, episode, syncControls) => catalog.setCurrentEpisode(season, episode, syncControls),
  setStatus,
  formatEpisodeLabel,
  formatClock,
  fetchPlaybackProgress,
  savePlaybackProgress,
  sendPlaybackProgressBeacon
});
const playback = createPlaybackController({
  elements,
  catalog,
  taskQueue,
  progressSync,
  setStatus,
  setBackgroundStatus,
  setBusy,
  setProgress,
  setProgressText,
  setQualityStage,
  formatEpisodeLabel,
  formatClock,
  getBootstrapQuality: () => getBootstrapQualityForMode(),
  isHdUpgradeEnabled: () => isHdUpgradeEnabledForMode(),
  formatRequestedQualityLabel: getRequestedQualityLabel,
  canPrefetchNext: () => canRunBackgroundTasks(),
  isBatchPrimeEnabled: () => canRunBackgroundTasks()
});

async function refreshEpisodes(force = false) {
  await catalog.refreshCatalog({
    force,
    foreground: true,
    preserveSelection: true
  });
  playback.syncWindow();
  scheduleFfmpegWarmup();
}
async function init() {
  setProgress(0);
  setProgressText('');
  applyPlaybackMode(state.playbackMode, { persist: true, showStatus: false });
  setBusy(true);
  const loadedFromCache = catalog.tryLoadCatalogFromCache();
  if (loadedFromCache) {
    setBusy(false);
  }
  try {
    await catalog.refreshCatalog({
      force: false,
      foreground: !loadedFromCache,
      silentError: loadedFromCache,
      preserveSelection: loadedFromCache
    });
  } catch {
    if (loadedFromCache && catalog.getCatalog()) {
      setStatus('Using cached episodes. Background refresh failed.', true);
    }
  }
  if (catalog.getCatalog()) {
    playback.syncWindow();
    await progressSync.restore();
    progressSync.start();
    scheduleFfmpegWarmup();
  } else {
    setBusy(false);
  }
}

elements.seasonSelect.addEventListener('change', () => {
  catalog.handleSeasonChange();
});
elements.episodeSelect.addEventListener('change', () => {
  catalog.handleEpisodeChange();
});
elements.playButton.addEventListener('click', () => {
  void playback.playSelectedEpisode(false);
});
elements.video.addEventListener('ended', () => {
  void playback.onVideoEnded();
});
elements.video.addEventListener('pause', () => {
  progressSync.onPause();
});
elements.video.addEventListener('timeupdate', () => {
  progressSync.onTimeUpdate();
});
elements.modeToggleButton.addEventListener('click', () => {
  if (state.isBusy || xboxSafeMode) {
    return;
  }
  const nextMode = state.playbackMode === PLAYBACK_MODE_MINIMAL ? PLAYBACK_MODE_STANDARD : PLAYBACK_MODE_MINIMAL;
  applyPlaybackMode(nextMode, { persist: true, showStatus: true });
});
elements.refreshEpisodesButton.addEventListener('click', () => {
  if (state.isBusy) {
    return;
  }
  void refreshEpisodes(true).catch(() => {
  });
});
globalThis.addEventListener('beforeunload', () => {
  progressSync.onClose();
});
globalThis.addEventListener('pagehide', () => {
  progressSync.onClose();
});

void init();

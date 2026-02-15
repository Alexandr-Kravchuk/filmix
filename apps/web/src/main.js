import './styles.css';
import { fetchShow, fetchSourceByEpisode, fetchSourceBatch, fetchPlaybackProgress, savePlaybackProgress, sendPlaybackProgressBeacon, getApiBaseUrl } from './api.js';
import { readShowCache, writeShowCache, clearShowCache } from './show-cache.js';
import { createCatalogController } from './catalog-controller.js';
import { createTaskQueue } from './task-queue.js';
import { createProgressSyncController } from './progress-sync.js';
import { createPlaybackController } from './playback-controller.js';

const elements = {
  showTitle: document.getElementById('show-title'),
  status: document.getElementById('status'),
  seasonSelect: document.getElementById('season-select'),
  episodeSelect: document.getElementById('episode-select'),
  playButton: document.getElementById('play-btn'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  video: document.getElementById('video'),
  menuButton: document.getElementById('menu-btn'),
  menuPanel: document.getElementById('menu-panel'),
  refreshEpisodesButton: document.getElementById('refresh-episodes-btn')
};

const state = {
  isBusy: false,
  isMenuOpen: false
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
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
function closeMenu() {
  state.isMenuOpen = false;
  elements.menuPanel.hidden = true;
  elements.menuButton.setAttribute('aria-expanded', 'false');
}
function openMenu() {
  if (elements.menuButton.disabled) {
    return;
  }
  state.isMenuOpen = true;
  elements.menuPanel.hidden = false;
  elements.menuButton.setAttribute('aria-expanded', 'true');
}
function toggleMenu() {
  if (state.isMenuOpen) {
    closeMenu();
    return;
  }
  openMenu();
}
function setBusy(isBusy) {
  state.isBusy = isBusy;
  elements.seasonSelect.disabled = isBusy;
  elements.episodeSelect.disabled = isBusy;
  elements.playButton.disabled = isBusy || !catalog.getCatalog();
  elements.menuButton.disabled = isBusy;
  elements.refreshEpisodesButton.disabled = isBusy;
  if (isBusy) {
    closeMenu();
  }
  if (!isBusy) {
    elements.playButton.textContent = 'Play';
  }
}
function scheduleFfmpegWarmup() {
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
  getApiBaseUrl
});

const catalog = createCatalogController({
  elements,
  fetchShow,
  readShowCache,
  writeShowCache,
  clearShowCache,
  setStatus,
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
  setBusy,
  setProgress,
  setProgressText,
  formatEpisodeLabel,
  formatClock
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

function onDocumentClick(event) {
  if (!state.isMenuOpen) {
    return;
  }
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }
  if (elements.menuPanel.contains(target) || elements.menuButton.contains(target)) {
    return;
  }
  closeMenu();
}
function onDocumentKeydown(event) {
  if (event.key === 'Escape') {
    closeMenu();
  }
}
async function init() {
  setProgress(0);
  setProgressText('');
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
elements.menuButton.addEventListener('click', () => {
  toggleMenu();
});
elements.refreshEpisodesButton.addEventListener('click', () => {
  closeMenu();
  if (state.isBusy) {
    return;
  }
  void refreshEpisodes(true).catch(() => {
  });
});
document.addEventListener('click', onDocumentClick);
document.addEventListener('keydown', onDocumentKeydown);
globalThis.addEventListener('beforeunload', () => {
  progressSync.onClose();
});
globalThis.addEventListener('pagehide', () => {
  progressSync.onClose();
});

void init();

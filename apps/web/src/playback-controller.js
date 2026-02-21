function formatEta(task) {
  const progress = Math.max(0, Math.min(1, Number(task.progress) || 0));
  if (progress < 0.03) {
    return 'calculating...';
  }
  const elapsedSeconds = (Date.now() - task.startedAt) / 1000;
  const remaining = Math.max(1, Math.round((elapsedSeconds * (1 - progress)) / progress));
  return `${remaining}s`;
}
function formatEpisodeCode(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}
function parseEntryQuality(entry) {
  const direct = Number.parseInt(String(entry && entry.quality ? entry.quality : ''), 10);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const label = String(entry && entry.qualityLabel ? entry.qualityLabel : '');
  const match = label.match(/(\d+)p/i);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}
async function seekVideoTo(video, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) {
    return;
  }
  const applySeek = () => {
    const duration = Number(video.duration || 0);
    if (Number.isFinite(duration) && duration > 1) {
      video.currentTime = Math.min(value, Math.max(0, duration - 1));
      return;
    }
    video.currentTime = value;
  };
  if (video.readyState >= 1) {
    applySeek();
    return;
  }
  await new Promise((resolve) => {
    const onLoadedMetadata = () => {
      applySeek();
      resolve();
    };
    video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
  });
}

export function createPlaybackController(options) {
  const state = {
    playRequestId: 0
  };
  function canPrefetchNext() {
    if (typeof options.canPrefetchNext === 'function') {
      return options.canPrefetchNext();
    }
    return true;
  }
  function isBatchPrimeEnabled() {
    if (typeof options.isBatchPrimeEnabled === 'function') {
      return options.isBatchPrimeEnabled();
    }
    return true;
  }
  function setQualityStage(stage) {
    if (typeof options.setQualityStage === 'function') {
      options.setQualityStage(stage);
    }
  }
  function setCurrentWindowTrim() {
    const current = options.catalog.getCurrentEpisode();
    const next = canPrefetchNext() ? options.catalog.getNextEpisode(current.season, current.episode) : null;
    options.taskQueue.trimPreparedEntries(current, next);
  }
  function renderForegroundProgress(task) {
    const percent = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
    const eta = formatEta(task);
    options.setProgress(task.progress);
    options.setProgressText(`${percent}% • ETA ${eta}`);
    options.elements.playButton.textContent = `Preparing... ${eta}`;
  }
  function renderBackgroundProgress(task) {
    const percent = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
    const eta = formatEta(task);
    const qualityLabel = task.qualityLabel || 'HD';
    options.setBackgroundStatus(`Preparing HD ${qualityLabel} in background: ${percent}% • ETA ${eta}`);
    options.setProgress(task.progress);
    options.setProgressText(`HD ${percent}% • ETA ${eta}`);
  }
  async function prepareEpisodeForeground(season, episode, quality, requestId) {
    const task = options.taskQueue.prepareEpisodeAtQuality(season, episode, quality);
    const requestedLabel = typeof options.formatRequestedQualityLabel === 'function'
      ? options.formatRequestedQualityLabel(quality)
      : task.qualityLabel;
    setQualityStage('preparing_480');
    options.setStatus(`Preparing English ${requestedLabel}...`);
    options.setBackgroundStatus('');
    options.setBusy(true);
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
        options.setProgress(1);
        options.setProgressText(`100% • Ready ${entry.qualityLabel}`);
      }
      return entry;
    } finally {
      globalThis.clearInterval(timer);
      options.setBusy(false);
    }
  }
  function collectBatchEpisodes(season, episode, count = 3) {
    const episodes = [episode];
    let current = { season, episode };
    while (episodes.length < count) {
      const next = options.catalog.getNextEpisode(current.season, current.episode);
      if (!next || next.season !== season) {
        break;
      }
      episodes.push(next.episode);
      current = next;
    }
    return episodes;
  }
  async function startPlayback(entry, isAutoStart) {
    const resumeTime = options.progressSync.getResumeTimeForEpisode(entry.season, entry.episode);
    const activeSrc = String(options.elements.video.currentSrc || options.elements.video.src || '');
    const sourceChanged = activeSrc !== entry.playUrl;
    if (sourceChanged) {
      options.elements.video.src = entry.playUrl;
      options.elements.video.load();
    }
    if (sourceChanged && resumeTime > 0) {
      await seekVideoTo(options.elements.video, resumeTime);
    }
    try {
      await options.elements.video.play();
      if (resumeTime > 0) {
        options.setStatus(`Playing ${formatEpisodeCode(entry.season, entry.episode)} in ${entry.qualityLabel} from ${options.formatClock(resumeTime)} (English)`);
      } else {
        options.setStatus(`Playing ${formatEpisodeCode(entry.season, entry.episode)} in ${entry.qualityLabel} (English)`);
      }
      setQualityStage('playing_480');
      return true;
    } catch {
      if (isAutoStart) {
        options.setStatus(`Autoplay blocked for ${options.formatEpisodeLabel(entry.season, entry.episode)}. Click Play.`, true);
      } else {
        options.setStatus(`Playback blocked for ${options.formatEpisodeLabel(entry.season, entry.episode)}. Click Play again.`, true);
      }
      return false;
    }
  }
  async function switchPlaybackQuality(currentEntry, nextEntry, requestId) {
    if (requestId !== state.playRequestId) {
      return;
    }
    const currentQuality = parseEntryQuality(currentEntry);
    const nextQuality = parseEntryQuality(nextEntry);
    if (nextEntry.playUrl === currentEntry.playUrl || nextQuality <= currentQuality) {
      options.setBackgroundStatus('HD ready');
      return;
    }
    const video = options.elements.video;
    const restore = {
      currentTime: Number(video.currentTime || 0),
      paused: !!video.paused,
      playbackRate: Number(video.playbackRate || 1),
      muted: !!video.muted,
      volume: Number(video.volume || 1)
    };
    options.setBackgroundStatus(`HD ready, switching to ${nextEntry.qualityLabel}...`);
    setQualityStage('preparing_max');
    video.src = nextEntry.playUrl;
    video.load();
    await seekVideoTo(video, restore.currentTime);
    video.playbackRate = restore.playbackRate;
    video.muted = restore.muted;
    video.volume = restore.volume;
    if (!restore.paused) {
      await video.play();
    }
    setQualityStage('playing_max');
    options.setStatus(`Switched to ${nextEntry.qualityLabel} (English)`);
    options.setBackgroundStatus('HD ready');
  }
  function maybePreloadNext(entry) {
    if (!canPrefetchNext()) {
      return;
    }
    const next = options.catalog.getNextEpisode(entry.season, entry.episode);
    if (!next) {
      return;
    }
    const bootstrapQuality = options.getBootstrapQuality();
    options.taskQueue.preloadEpisodeAtQuality(next.season, next.episode, bootstrapQuality);
    if (options.taskQueue.isPreparedAtQuality(entry.season, entry.episode, 'max')) {
      options.taskQueue.preloadEpisodeAtQuality(next.season, next.episode, 'max');
    }
  }
  async function runBackgroundUpgrade(entry, requestId) {
    if (!options.isHdUpgradeEnabled()) {
      return;
    }
    const task = options.taskQueue.prepareEpisodeAtQuality(entry.season, entry.episode, 'max');
    if (task.key === entry.key) {
      options.setBackgroundStatus('');
      return;
    }
    setQualityStage('preparing_max');
    renderBackgroundProgress(task);
    const timer = globalThis.setInterval(() => {
      if (requestId !== state.playRequestId) {
        return;
      }
      renderBackgroundProgress(task);
    }, 400);
    try {
      const maxEntry = await task.promise;
      if (requestId !== state.playRequestId) {
        return;
      }
      options.setProgress(1);
      options.setProgressText(`HD ready • ${maxEntry.qualityLabel}`);
      await switchPlaybackQuality(entry, maxEntry, requestId);
      maybePreloadNext(maxEntry);
    } catch {
      if (requestId !== state.playRequestId) {
        return;
      }
      setQualityStage('fallback_480');
      options.setBackgroundStatus('HD preparation failed, staying on 480p');
    } finally {
      globalThis.clearInterval(timer);
    }
  }
  async function playSelectedEpisode(isAutoStart = false) {
    const selected = options.catalog.getSelectedEpisodeFromControls();
    if (!selected) {
      options.setStatus('Select season and episode first', true);
      return;
    }
    options.catalog.setCurrentEpisode(selected.season, selected.episode, false);
    setCurrentWindowTrim();
    const requestId = state.playRequestId + 1;
    state.playRequestId = requestId;
    const bootstrapQuality = options.getBootstrapQuality();
    try {
      const entry = await prepareEpisodeForeground(selected.season, selected.episode, bootstrapQuality, requestId);
      if (requestId !== state.playRequestId) {
        return;
      }
      const started = await startPlayback(entry, isAutoStart);
      if (isBatchPrimeEnabled()) {
        const windowEpisodes = collectBatchEpisodes(entry.season, entry.episode, 3);
        void options.taskQueue.primeSourcesFromBatch(entry.season, windowEpisodes, bootstrapQuality);
        if (options.isHdUpgradeEnabled()) {
          void options.taskQueue.primeSourcesFromBatch(entry.season, windowEpisodes, 'max');
        }
      }
      maybePreloadNext(entry);
      setCurrentWindowTrim();
      if (!started) {
        return;
      }
      if (!options.isHdUpgradeEnabled()) {
        options.setBackgroundStatus('');
        return;
      }
      void runBackgroundUpgrade(entry, requestId);
    } catch (error) {
      const message = error && error.message ? error.message : 'Cannot prepare video';
      options.setStatus(message, true);
      options.setBackgroundStatus('');
      options.setProgress(0);
      options.setProgressText('');
    }
  }
  async function onVideoEnded() {
    const current = options.catalog.getCurrentEpisode();
    const next = options.catalog.getNextEpisode(current.season, current.episode);
    if (!next) {
      await options.progressSync.syncNow({ force: true });
      options.setStatus('Last available episode finished');
      options.setBackgroundStatus('');
      return;
    }
    await options.progressSync.syncNow({ force: true });
    options.catalog.setCurrentEpisode(next.season, next.episode, true);
    setCurrentWindowTrim();
    options.setStatus(`Auto-playing ${options.formatEpisodeLabel(next.season, next.episode)}`);
    options.setBackgroundStatus('');
    await playSelectedEpisode(true);
  }
  return {
    playSelectedEpisode,
    onVideoEnded,
    syncWindow: setCurrentWindowTrim
  };
}

function formatEta(task) {
  const progress = Math.max(0, Math.min(1, Number(task.progress) || 0));
  if (progress < 0.03) {
    return 'calculating...';
  }
  const elapsedSeconds = (Date.now() - task.startedAt) / 1000;
  const remaining = Math.max(1, Math.round((elapsedSeconds * (1 - progress)) / progress));
  return `${remaining}s`;
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
  function setCurrentWindowTrim() {
    const current = options.catalog.getCurrentEpisode();
    const next = options.catalog.getNextEpisode(current.season, current.episode);
    options.taskQueue.trimPreparedEntries(current, next);
  }
  function renderForegroundProgress(task) {
    const percent = Math.round(Math.max(0, Math.min(1, task.progress)) * 100);
    const eta = formatEta(task);
    options.setProgress(task.progress);
    options.setProgressText(`${percent}% • ETA ${eta}`);
    options.elements.playButton.textContent = `Preparing... ${eta}`;
  }
  async function prepareEpisodeForeground(season, episode, requestId) {
    const task = options.taskQueue.getOrCreateTask(season, episode);
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
        options.setProgressText('100% • Ready');
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
        options.setStatus(`Playing ${options.formatEpisodeLabel(entry.season, entry.episode)} from ${options.formatClock(resumeTime)} (English)`);
        return;
      }
      options.setStatus(`Playing ${options.formatEpisodeLabel(entry.season, entry.episode)} (English)`);
    } catch {
      if (isAutoStart) {
        options.setStatus(`Autoplay blocked for ${options.formatEpisodeLabel(entry.season, entry.episode)}. Click Play.`, true);
      } else {
        options.setStatus(`Playback blocked for ${options.formatEpisodeLabel(entry.season, entry.episode)}. Click Play again.`, true);
      }
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
    try {
      const entry = await prepareEpisodeForeground(selected.season, selected.episode, requestId);
      if (requestId !== state.playRequestId) {
        return;
      }
      await startPlayback(entry, isAutoStart);
      const next = options.catalog.getNextEpisode(entry.season, entry.episode);
      if (next) {
        options.taskQueue.preloadEpisode(next.season, next.episode);
      }
      const windowEpisodes = collectBatchEpisodes(entry.season, entry.episode, 3);
      void options.taskQueue.primeSourcesFromBatch(entry.season, windowEpisodes);
      setCurrentWindowTrim();
    } catch (error) {
      const message = error && error.message ? error.message : 'Cannot prepare video';
      options.setStatus(message, true);
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
      return;
    }
    await options.progressSync.syncNow({ force: true });
    options.catalog.setCurrentEpisode(next.season, next.episode, true);
    setCurrentWindowTrim();
    options.setStatus(`Auto-playing ${options.formatEpisodeLabel(next.season, next.episode)}`);
    await playSelectedEpisode(true);
  }
  return {
    playSelectedEpisode,
    onVideoEnded,
    syncWindow: setCurrentWindowTrim
  };
}

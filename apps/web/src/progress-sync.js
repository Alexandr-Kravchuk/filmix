function normalizePlaybackProgress(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const season = Number.parseInt(String(payload.season || ''), 10);
  const episode = Number.parseInt(String(payload.episode || ''), 10);
  const currentTimeRaw = Number(payload.currentTime);
  const durationRaw = Number(payload.duration);
  const updatedAtRaw = Number.parseInt(String(payload.updatedAt || ''), 10);
  if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) {
    return null;
  }
  if (!Number.isFinite(currentTimeRaw) || currentTimeRaw < 0) {
    return null;
  }
  const duration = Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 0;
  const currentTime = duration > 0 ? Math.min(currentTimeRaw, duration) : currentTimeRaw;
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now();
  return {
    season,
    episode,
    currentTime: Number(currentTime.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    updatedAt
  };
}
function hasChangedEnough(previous, current) {
  if (!previous) {
    return true;
  }
  if (previous.season !== current.season || previous.episode !== current.episode) {
    return true;
  }
  return Math.abs(Number(current.currentTime || 0) - Number(previous.currentTime || 0)) >= 5;
}

export function createProgressSyncController(options) {
  const state = {
    resumeProgress: null,
    lastSaved: null,
    dirty: false,
    syncInFlight: null,
    timer: null,
    pauseTimer: null
  };
  function buildPayload() {
    const current = options.getCurrentEpisode();
    if (!current || !Number.isFinite(current.season) || !Number.isFinite(current.episode)) {
      return null;
    }
    const activeSrc = String(options.video.currentSrc || options.video.src || '').trim();
    if (!activeSrc) {
      return null;
    }
    const currentTimeRaw = Number(options.video.currentTime || 0);
    if (!Number.isFinite(currentTimeRaw) || currentTimeRaw < 0) {
      return null;
    }
    const durationRaw = Number(options.video.duration || 0);
    const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : 0;
    const currentTime = duration > 0 ? Math.min(currentTimeRaw, duration) : currentTimeRaw;
    return {
      season: current.season,
      episode: current.episode,
      currentTime: Number(currentTime.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      updatedAt: Date.now()
    };
  }
  async function syncNow(args = {}) {
    if (state.syncInFlight) {
      return state.syncInFlight;
    }
    const payload = buildPayload();
    if (!payload) {
      return null;
    }
    const force = !!args.force;
    const changed = hasChangedEnough(state.lastSaved, payload);
    if (!force && !state.dirty && !changed) {
      return null;
    }
    if (!force && !changed) {
      return null;
    }
    const task = (async () => {
      const saved = await options.savePlaybackProgress(payload, {
        keepalive: !!args.keepalive
      });
      const normalized = normalizePlaybackProgress(saved) || payload;
      state.resumeProgress = normalized;
      state.lastSaved = normalized;
      state.dirty = false;
      return normalized;
    })().catch(() => null);
    state.syncInFlight = task;
    try {
      return await task;
    } finally {
      if (state.syncInFlight === task) {
        state.syncInFlight = null;
      }
    }
  }
  function markDirtyFromVideo() {
    const payload = buildPayload();
    if (!payload) {
      return;
    }
    if (hasChangedEnough(state.lastSaved, payload)) {
      state.dirty = true;
    }
  }
  function onPause() {
    if (state.pauseTimer) {
      globalThis.clearTimeout(state.pauseTimer);
    }
    state.pauseTimer = globalThis.setTimeout(() => {
      state.pauseTimer = null;
      void syncNow();
    }, 2000);
  }
  function onClose() {
    if (state.pauseTimer) {
      globalThis.clearTimeout(state.pauseTimer);
      state.pauseTimer = null;
    }
    const payload = buildPayload();
    if (!payload) {
      return;
    }
    if (!state.dirty && !hasChangedEnough(state.lastSaved, payload)) {
      return;
    }
    state.lastSaved = payload;
    state.dirty = false;
    if (options.sendPlaybackProgressBeacon(payload)) {
      return;
    }
    void options.savePlaybackProgress(payload, { keepalive: true }).catch(() => {
    });
  }
  function start() {
    if (state.timer) {
      return;
    }
    state.timer = globalThis.setInterval(() => {
      void syncNow();
    }, 60000);
  }
  function stop() {
    if (state.timer) {
      globalThis.clearInterval(state.timer);
      state.timer = null;
    }
    if (state.pauseTimer) {
      globalThis.clearTimeout(state.pauseTimer);
      state.pauseTimer = null;
    }
  }
  async function restore() {
    try {
      const payload = await options.fetchPlaybackProgress();
      const progress = normalizePlaybackProgress(payload);
      if (!progress) {
        return;
      }
      const episodes = options.getEpisodes(progress.season);
      if (!episodes.includes(progress.episode)) {
        return;
      }
      options.setCurrentEpisode(progress.season, progress.episode, true);
      state.resumeProgress = progress;
      state.lastSaved = progress;
      state.dirty = false;
      if (progress.currentTime > 0) {
        options.setStatus(`Resume available: ${options.formatEpisodeLabel(progress.season, progress.episode)} at ${options.formatClock(progress.currentTime)}. Press Play.`);
        return;
      }
      options.setStatus(`Resume available: ${options.formatEpisodeLabel(progress.season, progress.episode)}. Press Play.`);
    } catch {
    }
  }
  function getResumeTimeForEpisode(season, episode) {
    if (!state.resumeProgress) {
      return 0;
    }
    if (state.resumeProgress.season !== season || state.resumeProgress.episode !== episode) {
      return 0;
    }
    return Number(state.resumeProgress.currentTime) || 0;
  }
  return {
    restore,
    start,
    stop,
    syncNow,
    onPause,
    onClose,
    onTimeUpdate: markDirtyFromVideo,
    getResumeTimeForEpisode
  };
}

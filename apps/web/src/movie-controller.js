import { remuxEnglishTrack, segmentEnglishTrackFromBlob, getFfmpegLogTail, getFfmpegLastError } from './ffmpeg-engine.js';
import { createMovieLogUploader } from './movie-log-uploader.js';
import { readMovieProgress, writeMovieProgress, clearMovieProgress } from './movie-progress-store.js';

const XBOX_SEGMENT_SECONDS = 3600;
const DIAGNOSTIC_HISTORY_LIMIT = 80;
const VIDEO_EVENTS_TO_TRACK = ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'error', 'ended', 'emptied'];

const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;

function resolvePlaybackUrl(value, apiBaseUrl) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error('Movie playback URL is missing');
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return normalized;
  }
  return new URL(normalized, apiBaseUrl).toString();
}
function isMissingEnglishTrackError(error) {
  const message = String(error && error.message ? error.message : '');
  return /English track is not available/i.test(message);
}
function collectCandidates(payload) {
  const list = Array.isArray(payload && payload.candidates) ? payload.candidates : [];
  if (list.length) {
    return list;
  }
  if (payload && (payload.playbackUrl || payload.sourceUrl)) {
    return [{
      translationName: payload.translationName || '',
      quality: payload.quality || 0,
      playbackUrl: payload.playbackUrl || payload.sourceUrl
    }];
  }
  return [];
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
async function downloadSourceAsBlob(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Movie download failed: HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
    throw new Error(`Movie source URL is invalid or expired: expected video, got ${contentType}`);
  }
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(total) && total > MAX_SOURCE_BYTES) {
    const sizeMb = Math.round(total / (1024 * 1024));
    throw new Error(`Movie source is too large (${sizeMb}MB) for in-browser processing`);
  }
  const reader = response.body.getReader();
  const blobs = [];
  let received = 0;
  let chunkCount = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    const value = step.value;
    if (!value) {
      continue;
    }
    blobs.push(new Blob([value], { type: 'application/octet-stream' }));
    received += value.length;
    chunkCount += 1;
    if (total > 0) {
      onProgress(Math.min(0.99, received / total));
    } else {
      onProgress(Math.min(0.85, 0.08 + chunkCount * 0.03));
    }
    if (received > MAX_SOURCE_BYTES) {
      throw new Error(`Movie source exceeded ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB limit`);
    }
  }
  if (received === 0) {
    throw new Error('Movie source URL returned empty response body');
  }
  return new Blob(blobs, { type: contentType || 'video/mp4' });
}
async function downloadSource(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Movie download failed: HTTP ${response.status}`);
  }
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
    throw new Error(`Movie source URL is invalid or expired: expected video, got ${contentType}`);
  }
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(total) && total > MAX_SOURCE_BYTES) {
    const sizeMb = Math.round(total / (1024 * 1024));
    throw new Error(`Movie source is too large (${sizeMb}MB) for in-browser processing`);
  }
  const reader = response.body.getReader();
  if (total > 0) {
    const merged = new Uint8Array(total);
    let received = 0;
    while (true) {
      const step = await reader.read();
      if (step.done) {
        break;
      }
      const value = step.value;
      if (value) {
        if (received + value.length > merged.length) {
          throw new Error('Movie source stream exceeded declared content length');
        }
        merged.set(value, received);
        received += value.length;
        onProgress(Math.min(0.99, received / total));
      }
    }
    if (received === 0) {
      throw new Error('Movie source URL returned empty response body');
    }
    return received === merged.length ? merged : merged.slice(0, received);
  }
  const chunks = [];
  let received = 0;
  let chunkCount = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) {
      break;
    }
    const value = step.value;
    if (value) {
      chunks.push(value);
      received += value.length;
      chunkCount += 1;
      onProgress(Math.min(0.85, 0.08 + chunkCount * 0.03));
      if (received > MAX_SOURCE_BYTES) {
        throw new Error(`Movie source exceeded ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB limit`);
      }
    }
  }
  if (received === 0) {
    throw new Error('Movie source URL returned empty response body');
  }
  return concatChunks(chunks, received);
}

export function createMovieController(options) {
  const state = {
    requestId: 0,
    blobUrl: '',
    isBusy: false,
    segments: [],
    segmentIndex: 0,
    segmentSeconds: 0,
    onSegmentEnded: null,
    diagnostics: [],
    videoEventListeners: null,
    globalListenersAttached: false,
    persistTimer: null,
    pendingResumeAt: 0,
    movieUrl: '',
    movieDuration: 0,
    movieSegmentCount: 0,
    movieQuality: ''
  };
  const xboxSafeMode = options.xboxSafeMode === true;
  const uploader = options.logUploader || createMovieLogUploader({
    getApiBaseUrl: options.getApiBaseUrl
  });
  function pushDiagnostic(stage, details = {}) {
    const entry = {
      at: new Date().toISOString(),
      stage,
      ...details
    };
    state.diagnostics.push(entry);
    while (state.diagnostics.length > DIAGNOSTIC_HISTORY_LIMIT) {
      state.diagnostics.shift();
    }
    renderDiagnostics();
    try {
      const stored = JSON.stringify(state.diagnostics).slice(0, 100000);
      globalThis.localStorage && globalThis.localStorage.setItem('filmix-movie-diagnostics-v1', stored);
    } catch {
    }
    if (typeof console !== 'undefined' && typeof console.info === 'function') {
      console.info('[movie]', stage, details);
    }
    try {
      uploader.append(entry);
    } catch {
    }
  }
  function renderDiagnostics() {
    const target = options.elements && options.elements.movieDiagnostics;
    if (!target) {
      return;
    }
    const lines = state.diagnostics.slice(-30).map((entry) => {
      const at = entry.at.slice(11, 23);
      const rest = Object.entries(entry)
        .filter(([key]) => key !== 'at' && key !== 'stage')
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
        .join(' ');
      return `${at} ${entry.stage}${rest ? ' ' + rest : ''}`;
    });
    const header = `session: ${uploader.sessionId}`;
    target.textContent = `${header}\n${lines.join('\n')}`;
  }
  function attachVideoEventListeners() {
    if (state.videoEventListeners) {
      return;
    }
    const handlers = {};
    for (const eventName of VIDEO_EVENTS_TO_TRACK) {
      const handler = () => {
        const v = options.elements.video;
        const error = v && v.error ? `${v.error.code}:${v.error.message || ''}` : null;
        pushDiagnostic(`video:${eventName}`, {
          readyState: v ? v.readyState : null,
          networkState: v ? v.networkState : null,
          duration: v && Number.isFinite(v.duration) ? Number(v.duration.toFixed(2)) : null,
          currentTime: v ? Number((v.currentTime || 0).toFixed(2)) : null,
          paused: v ? v.paused : null,
          segmentIndex: state.segmentIndex,
          ...(error ? { error } : {})
        });
      };
      options.elements.video.addEventListener(eventName, handler);
      handlers[eventName] = handler;
    }
    state.videoEventListeners = handlers;
  }
  function detachVideoEventListeners() {
    if (!state.videoEventListeners) {
      return;
    }
    for (const [eventName, handler] of Object.entries(state.videoEventListeners)) {
      options.elements.video.removeEventListener(eventName, handler);
    }
    state.videoEventListeners = null;
  }
  function attachGlobalErrorListeners() {
    if (state.globalListenersAttached) {
      return;
    }
    state.globalListenersAttached = true;
    globalThis.addEventListener('error', (event) => {
      pushDiagnostic('window:error', {
        message: String(event && event.message ? event.message : 'unknown'),
        filename: String(event && event.filename ? event.filename : ''),
        lineno: event && event.lineno ? event.lineno : 0
      });
    });
    globalThis.addEventListener('unhandledrejection', (event) => {
      const reason = event && event.reason;
      pushDiagnostic('window:unhandledrejection', {
        message: String(reason && reason.message ? reason.message : reason || 'unknown'),
        name: String(reason && reason.name ? reason.name : '')
      });
    });
  }
  function readVideoCurrentTime() {
    const v = options.elements.video;
    if (!v) {
      return 0;
    }
    const value = Number(v.currentTime || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }
  function getCurrentGlobalTime() {
    const local = readVideoCurrentTime();
    const seconds = state.segmentSeconds || 0;
    const index = state.segmentIndex || 0;
    return index * seconds + local;
  }
  function persistProgress(force = false) {
    if (!state.movieUrl) {
      return;
    }
    const globalTime = getCurrentGlobalTime();
    if (!force && globalTime <= 0.5) {
      return;
    }
    writeMovieProgress({
      url: state.movieUrl,
      currentTime: globalTime,
      segmentIndex: state.segmentIndex,
      segmentSeconds: state.segmentSeconds,
      segmentCount: state.movieSegmentCount,
      duration: state.movieDuration,
      quality: state.movieQuality
    });
  }
  function schedulePersistProgress() {
    if (state.persistTimer) {
      return;
    }
    state.persistTimer = setTimeout(() => {
      state.persistTimer = null;
      persistProgress(false);
    }, 3000);
  }
  function attachPersistListeners() {
    const v = options.elements.video;
    if (!v) {
      return;
    }
    v.addEventListener('timeupdate', schedulePersistProgress);
    v.addEventListener('pause', () => persistProgress(true));
    v.addEventListener('ended', () => persistProgress(true));
    if (typeof globalThis.addEventListener === 'function') {
      const onUnload = () => persistProgress(true);
      globalThis.addEventListener('pagehide', onUnload);
      globalThis.addEventListener('beforeunload', onUnload);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'hidden') {
            persistProgress(true);
          }
        });
      }
    }
  }
  function applyPendingResume() {
    if (!(state.pendingResumeAt > 0)) {
      return;
    }
    const segments = state.segmentSeconds || 0;
    const segmentStart = (state.segmentIndex || 0) * segments;
    const target = Math.max(0, state.pendingResumeAt - segmentStart);
    state.pendingResumeAt = 0;
    if (target <= 1) {
      return;
    }
    const video = options.elements.video;
    if (!video) {
      return;
    }
    const dur = Number(video.duration || 0);
    const safeTarget = Number.isFinite(dur) && dur > 1 ? Math.min(target, dur - 0.5) : target;
    try {
      video.currentTime = safeTarget;
      pushDiagnostic('movie:resume_seek', { segmentIndex: state.segmentIndex, target: Number(safeTarget.toFixed(2)) });
    } catch (error) {
      pushDiagnostic('movie:resume_seek_failed', { message: error && error.message });
    }
  }
  attachVideoEventListeners();
  attachGlobalErrorListeners();
  attachPersistListeners();
  pushDiagnostic('controller:init', {
    xboxSafeMode,
    sessionId: uploader.sessionId,
    userAgent: typeof navigator === 'undefined' ? '' : String(navigator.userAgent || '').slice(0, 120),
    deviceMemory: typeof navigator !== 'undefined' && navigator.deviceMemory ? navigator.deviceMemory : null,
    hardwareConcurrency: typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : null
  });
  function setStatus(message, isError = false) {
    if (typeof options.setMovieStatus === 'function') {
      options.setMovieStatus(message, isError);
    }
  }
  function setBusy(value) {
    state.isBusy = !!value;
    options.elements.movieUrlInput.disabled = state.isBusy;
    options.elements.movieQualitySelect.disabled = state.isBusy || xboxSafeMode;
    options.elements.moviePlayButton.disabled = state.isBusy;
    options.elements.moviePlayButton.textContent = state.isBusy ? 'Preparing movie...' : 'Play movie (English)';
  }
  if (xboxSafeMode) {
    options.elements.movieQualitySelect.value = 'min';
    options.elements.movieQualitySelect.disabled = true;
  }
  function releaseBlob() {
    if (state.blobUrl) {
      URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = '';
    }
  }
  function detachSegmentEndedListener() {
    if (state.onSegmentEnded) {
      options.elements.video.removeEventListener('ended', state.onSegmentEnded);
      state.onSegmentEnded = null;
    }
  }
  function clearSegments() {
    detachSegmentEndedListener();
    state.segments = [];
    state.segmentIndex = 0;
    state.segmentSeconds = 0;
  }
  function formatSegmentRange(index) {
    const start = index * state.segmentSeconds;
    const end = start + state.segmentSeconds;
    function format(value) {
      const total = Math.max(0, Math.floor(value));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
    return `${format(start)}–${format(end)}`;
  }
  async function playSegmentAt(index, movieTitle, translationName) {
    const total = state.segments.length;
    if (index < 0 || index >= total) {
      pushDiagnostic('segment:out_of_range', { index, total });
      return;
    }
    state.segmentIndex = index;
    releaseBlob();
    const segmentBlob = state.segments[index];
    state.blobUrl = URL.createObjectURL(segmentBlob);
    pushDiagnostic('segment:load', { index, total, bytes: segmentBlob.size, url: state.blobUrl.slice(0, 60) });
    options.elements.video.src = state.blobUrl;
    options.elements.video.load();
    const partLabel = `part ${index + 1}/${total} (${formatSegmentRange(index)})`;
    try {
      await options.elements.video.play();
      pushDiagnostic('segment:play_started', { index });
      applyPendingResume();
      const translationLabel = translationName ? ` from ${translationName}` : '';
      setStatus(`Playing ${movieTitle} ${partLabel} in English${translationLabel}`);
    } catch (playError) {
      pushDiagnostic('segment:play_blocked', { index, name: playError && playError.name, message: playError && playError.message });
      setStatus(`Autoplay blocked on ${partLabel}. Click Play in the player to continue.`, true);
    }
  }
  function attachSegmentEndedListener(movieTitle, translationName) {
    detachSegmentEndedListener();
    state.onSegmentEnded = () => {
      const next = state.segmentIndex + 1;
      pushDiagnostic('segment:ended', { current: state.segmentIndex, next, total: state.segments.length });
      if (next >= state.segments.length) {
        setStatus(`Finished ${movieTitle} (${state.segments.length} parts)`);
        clearMovieProgress();
        return;
      }
      void playSegmentAt(next, movieTitle, translationName);
    };
    options.elements.video.addEventListener('ended', state.onSegmentEnded);
  }
  async function playMovieViaServerStreaming(url, quality, requestId) {
    pushDiagnostic('xbox:meta_start', { quality, segmentSeconds: XBOX_SEGMENT_SECONDS });
    setStatus('Probing duration on local server...');
    const meta = await options.fetchMovieMeta(url, quality, XBOX_SEGMENT_SECONDS);
    if (requestId !== state.requestId) {
      return;
    }
    const segmentCount = Number.isFinite(Number(meta && meta.segmentCount)) && Number(meta.segmentCount) > 0
      ? Math.floor(Number(meta.segmentCount))
      : 1;
    const segmentSeconds = Number.isFinite(Number(meta && meta.segmentSeconds)) && Number(meta.segmentSeconds) > 0
      ? Math.floor(Number(meta.segmentSeconds))
      : XBOX_SEGMENT_SECONDS;
    const movieTitle = meta && meta.title ? meta.title : 'movie';
    const primaryTranslation = meta && meta.primary && meta.primary.translationName ? meta.primary.translationName : '';
    state.movieUrl = url;
    state.movieDuration = Number(meta && meta.duration) || 0;
    state.movieSegmentCount = segmentCount;
    state.movieQuality = quality;
    let initialSegmentIndex = 0;
    if (state.pendingResumeAt > 0 && segmentSeconds > 0) {
      const computed = Math.floor(state.pendingResumeAt / segmentSeconds);
      if (Number.isFinite(computed) && computed >= 0 && computed < segmentCount) {
        initialSegmentIndex = computed;
      }
    }
    pushDiagnostic('xbox:meta_done', {
      duration: meta && meta.duration,
      segmentCount,
      segmentSeconds,
      translation: primaryTranslation,
      candidates: Array.isArray(meta && meta.candidates) ? meta.candidates.length : 0
    });
    clearSegments();
    state.segments = Array.from({ length: segmentCount }, (_, index) => ({
      url: options.buildMovieSegmentUrl({
        url,
        quality,
        segment: index,
        segmentSeconds,
        candidate: 0
      }),
      index,
      seconds: segmentSeconds
    }));
    state.segmentSeconds = segmentSeconds;
    detachSegmentEndedListener();
    state.onSegmentEnded = () => {
      const next = state.segmentIndex + 1;
      pushDiagnostic('xbox:segment_ended', { current: state.segmentIndex, next, total: state.segments.length });
      if (next >= state.segments.length) {
        setStatus(`Finished ${movieTitle} (${state.segments.length} parts)`);
        clearMovieProgress();
        return;
      }
      void playServerSegmentAt(next, movieTitle, primaryTranslation);
    };
    options.elements.video.addEventListener('ended', state.onSegmentEnded);
    options.setProgress(1);
    options.setProgressText(`Streaming via local server • ${segmentCount} parts × ~${Math.round(segmentSeconds / 60)} min`);
    await playServerSegmentAt(initialSegmentIndex, movieTitle, primaryTranslation);
  }
  async function playServerSegmentAt(index, movieTitle, translationName) {
    const total = state.segments.length;
    if (index < 0 || index >= total) {
      pushDiagnostic('xbox:segment_out_of_range', { index, total });
      return;
    }
    state.segmentIndex = index;
    releaseBlob();
    const entry = state.segments[index];
    const partLabel = `part ${index + 1}/${total} (${formatSegmentRange(index)})`;
    pushDiagnostic('xbox:segment_load', { index, total, url: String(entry.url).slice(0, 120) });
    options.elements.video.src = entry.url;
    options.elements.video.load();
    try {
      await options.elements.video.play();
      pushDiagnostic('xbox:segment_play_started', { index });
      applyPendingResume();
      const translationLabel = translationName ? ` from ${translationName}` : '';
      setStatus(`Playing ${movieTitle} ${partLabel} in English${translationLabel}`);
    } catch (playError) {
      pushDiagnostic('xbox:segment_play_blocked', { index, name: playError && playError.name, message: playError && playError.message });
      setStatus(`Autoplay blocked on ${partLabel}. Click Play in the player to continue.`, true);
    }
  }
  async function playSelectedMovie() {
    if (state.isBusy) {
      return;
    }
    const url = String(options.elements.movieUrlInput.value || '').trim();
    if (!url) {
      setStatus('Paste a Filmix movie URL first', true);
      return;
    }
    state.diagnostics = [];
    pushDiagnostic('flow:start', { url: url.slice(0, 120), xboxSafeMode });
    const stored = readMovieProgress();
    if (!stored || stored.url !== url) {
      state.pendingResumeAt = 0;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      setStatus('Invalid URL format', true);
      return;
    }
    if (!/(^|\.)filmix\./i.test(parsed.hostname)) {
      setStatus('URL must point to a filmix.* host', true);
      return;
    }
    const quality = xboxSafeMode ? 'min' : String(options.elements.movieQualitySelect.value || 'max');
    const requestId = state.requestId + 1;
    state.requestId = requestId;
    setBusy(true);
    setStatus('Resolving Filmix sources...');
    options.setProgress(0);
    options.setProgressText('');
    if (xboxSafeMode) {
      try {
        await playMovieViaServerStreaming(url, quality, requestId);
      } catch (error) {
        if (requestId !== state.requestId) {
          return;
        }
        const message = error && error.message ? error.message : 'Cannot prepare movie';
        pushDiagnostic('flow:error', { name: error && error.name, message });
        setStatus(message, true);
        options.setProgress(0);
        options.setProgressText('');
      } finally {
        if (requestId === state.requestId) {
          setBusy(false);
        }
      }
      return;
    }
    try {
      pushDiagnostic('api:request', { quality });
      const payload = await options.fetchMovieByUrl(url, quality);
      if (requestId !== state.requestId) {
        return;
      }
      const candidates = collectCandidates(payload);
      pushDiagnostic('api:response', {
        title: (payload && payload.title) || '',
        candidates: candidates.length,
        primaryTranslation: candidates[0] && candidates[0].translationName,
        primaryQuality: candidates[0] && candidates[0].quality
      });
      if (!candidates.length) {
        throw new Error('Movie playback URL is missing');
      }
      const movieTitle = payload && payload.title ? payload.title : 'movie';
      clearSegments();
      let segmentResult = null;
      let outputBytes = null;
      let usedCandidate = null;
      let lastError = null;
      for (let index = 0; index < candidates.length; index += 1) {
        if (requestId !== state.requestId) {
          return;
        }
        const candidate = candidates[index];
        const translation = candidate.translationName ? ` (${candidate.translationName})` : '';
        const qualityLabel = candidate.quality ? ` ${candidate.quality}p` : '';
        const candidateLabel = candidates.length > 1 ? ` [${index + 1}/${candidates.length}]` : '';
        setStatus(`Downloading${translation}${qualityLabel}${candidateLabel}...`);
        const candidateUrl = resolvePlaybackUrl(candidate.playbackUrl, options.getApiBaseUrl());
        pushDiagnostic('download:start', {
          candidateIndex: index,
          translation: candidate.translationName,
          quality: candidate.quality,
          mode: xboxSafeMode ? 'blob' : 'uint8'
        });
        let sourceBytes = null;
        let sourceBlob = null;
        try {
          if (xboxSafeMode) {
            sourceBlob = await downloadSourceAsBlob(candidateUrl, (progress) => {
              if (requestId !== state.requestId) {
                return;
              }
              options.setProgress(0.05 + progress * 0.5);
              options.setProgressText(`${Math.round(progress * 100)}% downloading${candidateLabel}`);
            });
            pushDiagnostic('download:done', { candidateIndex: index, bytes: sourceBlob.size, mode: 'blob' });
          } else {
            sourceBytes = await downloadSource(candidateUrl, (progress) => {
              if (requestId !== state.requestId) {
                return;
              }
              options.setProgress(0.05 + progress * 0.5);
              options.setProgressText(`${Math.round(progress * 100)}% downloading${candidateLabel}`);
            });
            pushDiagnostic('download:done', { candidateIndex: index, bytes: sourceBytes.length, mode: 'uint8' });
          }
        } catch (downloadError) {
          pushDiagnostic('download:failed', { candidateIndex: index, name: downloadError && downloadError.name, message: downloadError && downloadError.message });
          lastError = downloadError;
          continue;
        }
        if (requestId !== state.requestId) {
          return;
        }
        const remuxLabel = xboxSafeMode ? 'splitting English track into parts' : 'remuxing English track';
        setStatus(`Extracting English audio track${translation}${candidateLabel}...`);
        try {
          if (xboxSafeMode) {
            pushDiagnostic('ffmpeg:segment_start', {
              candidateIndex: index,
              segmentSeconds: XBOX_SEGMENT_SECONDS,
              source: 'workerfs',
              blobBytes: sourceBlob ? sourceBlob.size : 0
            });
            segmentResult = await segmentEnglishTrackFromBlob(
              sourceBlob,
              (progress) => {
                if (requestId !== state.requestId) {
                  return;
                }
                options.setProgress(0.6 + progress * 0.38);
                options.setProgressText(`${Math.round(progress * 100)}% ${remuxLabel}${candidateLabel}`);
              },
              {
                releaseAfter: true,
                segmentSeconds: XBOX_SEGMENT_SECONDS,
                onDiagnostic: (stage, details) => {
                  pushDiagnostic(stage, { ...details, candidateIndex: index });
                }
              }
            );
            sourceBlob = null;
            pushDiagnostic('ffmpeg:segment_done', {
              candidateIndex: index,
              segments: segmentResult.segments.length,
              totalBytes: segmentResult.segments.reduce((sum, blob) => sum + blob.size, 0)
            });
          } else {
            pushDiagnostic('ffmpeg:remux_start', { candidateIndex: index });
            outputBytes = await remuxEnglishTrack(
              sourceBytes,
              (progress) => {
                if (requestId !== state.requestId) {
                  return;
                }
                options.setProgress(0.6 + progress * 0.38);
                options.setProgressText(`${Math.round(progress * 100)}% ${remuxLabel}${candidateLabel}`);
              },
              { releaseAfter: false }
            );
            pushDiagnostic('ffmpeg:remux_done', { candidateIndex: index, bytes: outputBytes.length });
          }
          usedCandidate = candidate;
          break;
        } catch (remuxError) {
          pushDiagnostic('ffmpeg:failed', {
            candidateIndex: index,
            name: remuxError && remuxError.name,
            message: remuxError && remuxError.message,
            ffmpegLastError: getFfmpegLastError(),
            ffmpegTail: getFfmpegLogTail(8)
          });
          lastError = remuxError;
          if (!isMissingEnglishTrackError(remuxError)) {
            throw remuxError;
          }
          continue;
        }
      }
      if ((!outputBytes && !segmentResult) || !usedCandidate) {
        throw lastError || new Error('No movie translation contains an English audio track');
      }
      if (requestId !== state.requestId) {
        return;
      }
      const translationName = usedCandidate.translationName || '';
      state.movieUrl = url;
      state.movieQuality = quality;
      if (segmentResult) {
        state.segments = segmentResult.segments.map((entry) => entry instanceof Blob ? entry : new Blob([entry], { type: 'video/mp4' }));
        state.segmentSeconds = segmentResult.segmentSeconds;
        state.movieSegmentCount = state.segments.length;
        let initialIndex = 0;
        if (state.pendingResumeAt > 0 && state.segmentSeconds > 0) {
          const computed = Math.floor(state.pendingResumeAt / state.segmentSeconds);
          if (Number.isFinite(computed) && computed >= 0 && computed < state.segments.length) {
            initialIndex = computed;
          }
        }
        pushDiagnostic('segments:ready', {
          count: state.segments.length,
          segmentSeconds: state.segmentSeconds,
          sizes: state.segments.map((blob) => blob.size)
        });
        attachSegmentEndedListener(movieTitle, translationName);
        await playSegmentAt(initialIndex, movieTitle, translationName);
        options.setProgress(1);
        options.setProgressText(`Ready • ${state.segments.length} parts × ~${Math.round(state.segmentSeconds / 60)} min`);
      } else {
        state.segmentSeconds = 0;
        state.movieSegmentCount = 1;
        state.segmentIndex = 0;
        const blob = new Blob([outputBytes], { type: 'video/mp4' });
        releaseBlob();
        state.blobUrl = URL.createObjectURL(blob);
        options.elements.video.src = state.blobUrl;
        options.elements.video.load();
        try {
          await options.elements.video.play();
          applyPendingResume();
          const translationLabel = translationName ? ` from ${translationName}` : '';
          setStatus(`Playing ${movieTitle} in English${translationLabel}`);
        } catch {
          setStatus('Autoplay blocked. Click Play in the player to start.', true);
        }
        options.setProgress(1);
        options.setProgressText('100% • Ready');
      }
    } catch (error) {
      if (requestId !== state.requestId) {
        return;
      }
      const message = error && error.message ? error.message : 'Cannot prepare movie';
      pushDiagnostic('flow:error', {
        name: error && error.name,
        message,
        ffmpegLastError: getFfmpegLastError(),
        ffmpegTail: getFfmpegLogTail(12)
      });
      setStatus(message, true);
      options.setProgress(0);
      options.setProgressText('');
    } finally {
      if (requestId === state.requestId) {
        setBusy(false);
      }
    }
  }
  function release() {
    releaseBlob();
    clearSegments();
  }
  function tryRestore({ autoStart = true } = {}) {
    const stored = readMovieProgress();
    if (!stored || !stored.url) {
      return false;
    }
    if (options.elements.movieUrlInput) {
      options.elements.movieUrlInput.value = stored.url;
    }
    if (stored.quality) {
      const select = options.elements.movieQualitySelect;
      if (select && Array.from(select.options || []).some((opt) => opt.value === stored.quality)) {
        select.value = stored.quality;
      }
    }
    state.pendingResumeAt = Number(stored.currentTime) > 0 ? Number(stored.currentTime) : 0;
    pushDiagnostic('movie:resume_state_restored', {
      currentTime: state.pendingResumeAt,
      url: String(stored.url).slice(0, 120)
    });
    if (state.pendingResumeAt > 0) {
      const minutes = Math.floor(state.pendingResumeAt / 60);
      const seconds = Math.floor(state.pendingResumeAt % 60);
      setStatus(`Resume position ${minutes}:${String(seconds).padStart(2, '0')} restored. ${autoStart && xboxSafeMode ? 'Auto-playing...' : 'Press Play to continue.'}`);
    }
    if (autoStart && xboxSafeMode) {
      void playSelectedMovie();
      return true;
    }
    return true;
  }
  return {
    playSelectedMovie,
    release,
    tryRestore
  };
}

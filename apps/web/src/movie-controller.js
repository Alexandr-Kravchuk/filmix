import { remuxEnglishTrack, segmentEnglishTrack } from './ffmpeg-engine.js';

const XBOX_SEGMENT_SECONDS = 1200;

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
    onSegmentEnded: null
  };
  const xboxSafeMode = options.xboxSafeMode === true;
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
      return;
    }
    state.segmentIndex = index;
    releaseBlob();
    state.blobUrl = URL.createObjectURL(state.segments[index]);
    options.elements.video.src = state.blobUrl;
    options.elements.video.load();
    const partLabel = `part ${index + 1}/${total} (${formatSegmentRange(index)})`;
    try {
      await options.elements.video.play();
      const translationLabel = translationName ? ` from ${translationName}` : '';
      setStatus(`Playing ${movieTitle} ${partLabel} in English${translationLabel}`);
    } catch {
      setStatus(`Autoplay blocked on ${partLabel}. Click Play in the player to continue.`, true);
    }
  }
  function attachSegmentEndedListener(movieTitle, translationName) {
    detachSegmentEndedListener();
    state.onSegmentEnded = () => {
      const next = state.segmentIndex + 1;
      if (next >= state.segments.length) {
        setStatus(`Finished ${movieTitle} (${state.segments.length} parts)`);
        return;
      }
      void playSegmentAt(next, movieTitle, translationName);
    };
    options.elements.video.addEventListener('ended', state.onSegmentEnded);
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
    try {
      const payload = await options.fetchMovieByUrl(url, quality);
      if (requestId !== state.requestId) {
        return;
      }
      const candidates = collectCandidates(payload);
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
        let sourceBytes;
        try {
          sourceBytes = await downloadSource(candidateUrl, (progress) => {
            if (requestId !== state.requestId) {
              return;
            }
            options.setProgress(0.05 + progress * 0.5);
            options.setProgressText(`${Math.round(progress * 100)}% downloading${candidateLabel}`);
          });
        } catch (downloadError) {
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
            segmentResult = await segmentEnglishTrack(
              sourceBytes,
              (progress) => {
                if (requestId !== state.requestId) {
                  return;
                }
                options.setProgress(0.6 + progress * 0.38);
                options.setProgressText(`${Math.round(progress * 100)}% ${remuxLabel}${candidateLabel}`);
              },
              { releaseAfter: true, segmentSeconds: XBOX_SEGMENT_SECONDS }
            );
          } else {
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
          }
          usedCandidate = candidate;
          break;
        } catch (remuxError) {
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
      if (segmentResult) {
        state.segments = segmentResult.segments.map((bytes) => new Blob([bytes], { type: 'video/mp4' }));
        state.segmentSeconds = segmentResult.segmentSeconds;
        attachSegmentEndedListener(movieTitle, translationName);
        await playSegmentAt(0, movieTitle, translationName);
        options.setProgress(1);
        options.setProgressText(`Ready • ${state.segments.length} parts × ~${Math.round(state.segmentSeconds / 60)} min`);
      } else {
        const blob = new Blob([outputBytes], { type: 'video/mp4' });
        releaseBlob();
        state.blobUrl = URL.createObjectURL(blob);
        options.elements.video.src = state.blobUrl;
        options.elements.video.load();
        try {
          await options.elements.video.play();
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
  return {
    playSelectedMovie,
    release
  };
}

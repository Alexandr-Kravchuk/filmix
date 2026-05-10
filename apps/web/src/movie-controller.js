import { remuxEnglishTrack } from './ffmpeg-engine.js';

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
    isBusy: false
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
        setStatus(`Extracting English audio track${translation}${candidateLabel}...`);
        try {
          outputBytes = await remuxEnglishTrack(
            sourceBytes,
            (progress) => {
              if (requestId !== state.requestId) {
                return;
              }
              options.setProgress(0.6 + progress * 0.38);
              options.setProgressText(`${Math.round(progress * 100)}% remuxing English track${candidateLabel}`);
            },
            { releaseAfter: xboxSafeMode }
          );
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
      if (!outputBytes || !usedCandidate) {
        throw lastError || new Error('No movie translation contains an English audio track');
      }
      if (requestId !== state.requestId) {
        return;
      }
      const blob = new Blob([outputBytes], { type: 'video/mp4' });
      releaseBlob();
      state.blobUrl = URL.createObjectURL(blob);
      options.elements.video.src = state.blobUrl;
      options.elements.video.load();
      try {
        await options.elements.video.play();
        const translationLabel = usedCandidate.translationName ? ` from ${usedCandidate.translationName}` : '';
        setStatus(`Playing ${movieTitle} in English${translationLabel}`);
      } catch {
        setStatus('Autoplay blocked. Click Play in the player to start.', true);
      }
      options.setProgress(1);
      options.setProgressText('100% • Ready');
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
  }
  return {
    playSelectedMovie,
    release
  };
}

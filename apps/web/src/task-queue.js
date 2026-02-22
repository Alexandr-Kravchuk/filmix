import { remuxEnglishTrack, warmupFfmpeg } from './ffmpeg-engine.js';
import { buildSourceCacheKey, readSourceUrl, writeSourceUrl, writeSourceUrls } from './source-cache.js';

const DIAGNOSTIC_HISTORY_LIMIT = 40;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_CACHE_NAME = 'filmix-en-track-cache-v1';

function normalizeQualityRequest(quality) {
  if (quality === undefined || quality === null || String(quality).trim() === '') {
    return 'max';
  }
  const normalized = String(quality).trim().toLowerCase();
  if (normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return 'max';
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 'max';
  }
  return String(parsed);
}
function normalizeQualityLabel(quality) {
  const normalized = normalizeQualityRequest(quality);
  if (normalized === 'max') {
    return 'max';
  }
  return `${normalized}p`;
}
function parseSourceQualityFromUrl(value) {
  const sourceUrl = String(value || '');
  const match = sourceUrl.match(/_(\d+)\.mp4(?:$|[?&#])/i);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}
function parseQualityFromPayload(value, sourceUrl) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return parseSourceQualityFromUrl(sourceUrl);
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

export function buildEpisodeKey(season, episode) {
  return `${season}:${episode}`;
}
export function buildTaskKey(season, episode, quality) {
  return `${season}:${episode}:${normalizeQualityRequest(quality)}`;
}
export function buildOutputCacheId(season, episode, sourceUrl) {
  const episodeKey = buildEpisodeKey(season, episode);
  const normalizedSource = String(sourceUrl || '').trim();
  if (!normalizedSource) {
    return episodeKey;
  }
  try {
    const parsed = new URL(normalizedSource);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const normalizedSegments = segments.length >= 3 && segments[0] === 's' ? segments.slice(2) : segments;
    const suffixSegments = normalizedSegments.length >= 2 ? normalizedSegments.slice(-2) : normalizedSegments;
    const suffix = suffixSegments.join('/');
    if (suffix) {
      return `${episodeKey}:${parsed.host}/${suffix}`.toLowerCase();
    }
    return `${episodeKey}:${parsed.host}`.toLowerCase();
  } catch {
    const fallbackSource = normalizedSource.split('?')[0];
    return `${episodeKey}:${fallbackSource}`.toLowerCase();
  }
}

export function createTaskQueue(options) {
  const prepared = new Map();
  const tasks = new Map();
  const diagnostics = [];
  const bootstrapQuality = normalizeQualityRequest(options.bootstrapQuality || 480);
  const enableOutputCache = options.enableOutputCache !== false;
  const releaseFfmpegAfterTask = options.releaseFfmpegAfterTask === true;
  const preferLowestQualityFromLadder = options.preferLowestQualityFromLadder === true;

  function pushDiagnostic(type, details = {}) {
    diagnostics.push({
      at: new Date().toISOString(),
      type,
      ...details
    });
    while (diagnostics.length > DIAGNOSTIC_HISTORY_LIMIT) {
      diagnostics.shift();
    }
    if (typeof options.onDiagnostic === 'function') {
      options.onDiagnostic(diagnostics[diagnostics.length - 1], diagnostics.slice());
    }
  }
  function getDiagnosticsSnapshot() {
    return diagnostics.slice();
  }
  function getCacheKey(season, episode, sourceUrl) {
    return `https://filmix-cache.local/en-track/${encodeURIComponent(buildOutputCacheId(season, episode, sourceUrl))}`;
  }
  function resolveSourceUrl(value) {
    const sourceUrl = String(value || '').trim();
    if (!sourceUrl) {
      throw new Error('Backend returned empty source URL');
    }
    if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
      return sourceUrl;
    }
    return new URL(sourceUrl, options.getApiBaseUrl()).toString();
  }
  async function loadCachedOutput(season, episode, sourceUrl) {
    if (!enableOutputCache || !('caches' in globalThis)) {
      return null;
    }
    const cache = await caches.open(OUTPUT_CACHE_NAME);
    const response = await cache.match(getCacheKey(season, episode, sourceUrl));
    if (!response) {
      return null;
    }
    const blob = await response.blob();
    if (!blob.size) {
      return null;
    }
    return blob;
  }
  async function saveCachedOutput(season, episode, sourceUrl, blob) {
    if (!enableOutputCache || !('caches' in globalThis)) {
      return;
    }
    const cache = await caches.open(OUTPUT_CACHE_NAME);
    await cache.put(
      getCacheKey(season, episode, sourceUrl),
      new Response(blob, {
        headers: {
          'Content-Type': 'video/mp4'
        }
      })
    );
  }
  async function downloadSourceFile(url, onProgress, context = {}) {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
      throw new Error(`Source URL is invalid or expired: expected video, got ${contentType}`);
    }
    const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
    pushDiagnostic('download_started', {
      season: context.season,
      episode: context.episode,
      requestedQuality: context.requestedQuality || '',
      sourceUrl: url,
      contentType: contentType || '',
      contentLength: Number.isFinite(total) ? total : 0
    });
    if (Number.isFinite(total) && total > MAX_SOURCE_BYTES) {
      const sizeMb = Math.round(total / (1024 * 1024));
      pushDiagnostic('download_rejected_too_large', {
        season: context.season,
        episode: context.episode,
        requestedQuality: context.requestedQuality || '',
        contentLength: total,
        maxBytes: MAX_SOURCE_BYTES
      });
      throw new Error(`Source is too large (${sizeMb}MB) for frontend processing`);
    }
    const reader = response.body.getReader();
    if (total > 0) {
      const merged = new Uint8Array(total);
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          if (received + value.length > merged.length) {
            throw new Error('Source stream exceeded declared content length');
          }
          merged.set(value, received);
          received += value.length;
          onProgress(Math.min(0.99, received / total));
        }
      }
      if (received === 0) {
        throw new Error('Source URL returned empty response body');
      }
      pushDiagnostic('download_completed', {
        season: context.season,
        episode: context.episode,
        requestedQuality: context.requestedQuality || '',
        bytesReceived: received
      });
      if (received === merged.length) {
        return merged;
      }
      return merged.slice(0, received);
    }
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
        onProgress(Math.min(0.85, 0.08 + chunkCount * 0.03));
        if (received > MAX_SOURCE_BYTES) {
          throw new Error(`Downloaded stream exceeded ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB limit`);
        }
      }
    }
    if (received === 0) {
      throw new Error('Source URL returned empty response body');
    }
    pushDiagnostic('download_completed', {
      season: context.season,
      episode: context.episode,
      requestedQuality: context.requestedQuality || '',
      bytesReceived: received
    });
    return concatChunks(chunks, received);
  }
  function isDownloadError(error) {
    const message = String(error && error.message ? error.message : '').toLowerCase();
    return message.startsWith('download failed:') || message.includes('invalid or expired') || message.includes('empty response body');
  }
  async function buildOutputBlob(sourceUrl, setTaskProgress, context) {
    const sourceBytes = await downloadSourceFile(sourceUrl, (downloadProgress) => setTaskProgress(0.05 + downloadProgress * 0.5), context);
    const outputBytes = await remuxEnglishTrack(
      sourceBytes,
      (ffmpegProgress) => setTaskProgress(0.6 + ffmpegProgress * 0.38),
      { releaseAfter: releaseFfmpegAfterTask }
    );
    return new Blob([outputBytes], { type: 'video/mp4' });
  }
  function upsertPreparedEntry(season, episode, qualityRequest, sourceUrl, quality, outputBlob) {
    const taskKey = buildTaskKey(season, episode, qualityRequest);
    const oldEntry = prepared.get(taskKey);
    if (oldEntry && oldEntry.blobUrl) {
      URL.revokeObjectURL(oldEntry.blobUrl);
    }
    const blobUrl = URL.createObjectURL(outputBlob);
    const entry = {
      key: taskKey,
      season,
      episode,
      requestedQuality: normalizeQualityRequest(qualityRequest),
      quality,
      qualityLabel: normalizeQualityLabel(quality || qualityRequest),
      sourceUrl,
      playUrl: blobUrl,
      blobUrl
    };
    prepared.set(taskKey, entry);
    return entry;
  }
  async function resolveLowestSourceFromLadder(season, episode) {
    if (typeof options.fetchSourceLadder !== 'function') {
      return null;
    }
    const payload = await options.fetchSourceLadder(season, episode);
    const sources = Array.isArray(payload && payload.sources) ? payload.sources : [];
    let best = null;
    for (const item of sources) {
      if (!item || typeof item.sourceUrl !== 'string') {
        continue;
      }
      const sourceUrl = resolveSourceUrl(item.sourceUrl);
      const quality = parseQualityFromPayload(item.quality, sourceUrl);
      if (!(quality > 0)) {
        continue;
      }
      if (!best || quality < best.quality) {
        best = { sourceUrl, quality };
      }
    }
    if (best) {
      pushDiagnostic('ladder_lowest_selected', {
        season,
        episode,
        quality: best.quality,
        sourceUrl: best.sourceUrl
      });
    }
    return best;
  }
  async function resolveSourceForEpisode(season, episode, qualityRequest) {
    const normalizedQuality = normalizeQualityRequest(qualityRequest);
    const sourceKey = buildSourceCacheKey(season, episode, normalizedQuality);
    const cachedSource = readSourceUrl(sourceKey);
    if (cachedSource) {
      const sourceUrl = resolveSourceUrl(cachedSource);
      return {
        sourceUrl,
        quality: parseSourceQualityFromUrl(sourceUrl)
      };
    }
    if (preferLowestQualityFromLadder && normalizedQuality !== 'max') {
      try {
        const lowest = await resolveLowestSourceFromLadder(season, episode);
        if (lowest) {
          writeSourceUrl(sourceKey, lowest.sourceUrl);
          writeSourceUrl(buildSourceCacheKey(season, episode, lowest.quality), lowest.sourceUrl);
          return lowest;
        }
      } catch (error) {
        pushDiagnostic('ladder_fetch_failed', {
          season,
          episode,
          message: String(error && error.message ? error.message : error)
        });
      }
    }
    const payload = await options.fetchSourceByEpisode(season, episode, normalizedQuality);
    const sourceUrl = resolveSourceUrl(payload.sourceUrl);
    const quality = parseQualityFromPayload(payload.quality, sourceUrl);
    writeSourceUrl(sourceKey, sourceUrl);
    if (quality > 0) {
      writeSourceUrl(buildSourceCacheKey(season, episode, quality), sourceUrl);
    }
    return { sourceUrl, quality };
  }
  async function primeSourcesFromBatch(season, episodes, quality = 'max') {
    const normalizedEpisodes = Array.from(new Set((Array.isArray(episodes) ? episodes : [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0)));
    if (!normalizedEpisodes.length) {
      return;
    }
    const normalizedQuality = normalizeQualityRequest(quality);
    try {
      const payload = await options.fetchSourceBatch(season, normalizedEpisodes, normalizedQuality);
      const entries = [];
      for (const item of Array.isArray(payload && payload.items) ? payload.items : []) {
        const episode = Number.parseInt(String(item.episode || ''), 10);
        if (!Number.isFinite(episode) || episode <= 0 || typeof item.sourceUrl !== 'string') {
          continue;
        }
        const sourceUrl = resolveSourceUrl(item.sourceUrl);
        const resolvedQuality = parseQualityFromPayload(item.quality, sourceUrl);
        entries.push({
          episodeKey: buildSourceCacheKey(season, episode, normalizedQuality),
          sourceUrl
        });
        if (resolvedQuality > 0) {
          entries.push({
            episodeKey: buildSourceCacheKey(season, episode, resolvedQuality),
            sourceUrl
          });
        }
      }
      if (entries.length) {
        writeSourceUrls(entries);
      }
    } catch {
    }
  }
  function prepareEpisodeAtQuality(season, episode, qualityRequest = 'max') {
    const normalizedQuality = normalizeQualityRequest(qualityRequest);
    const key = buildTaskKey(season, episode, normalizedQuality);
    const existing = tasks.get(key);
    if (existing) {
      return existing;
    }
    const task = {
      key,
      season,
      episode,
      requestedQuality: normalizedQuality,
      startedAt: Date.now(),
      progress: 0,
      quality: 0,
      qualityLabel: normalizeQualityLabel(normalizedQuality),
      promise: null
    };
    const setTaskProgress = (value) => {
      const normalized = Math.max(0, Math.min(1, Number(value) || 0));
      task.progress = Math.max(task.progress, normalized);
    };
    task.promise = (async () => {
      if (prepared.has(key)) {
        task.progress = 1;
        return prepared.get(key);
      }
      setTaskProgress(0.02);
      let source = await resolveSourceForEpisode(season, episode, normalizedQuality);
      task.quality = source.quality;
      if (source.quality > 0) {
        task.qualityLabel = normalizeQualityLabel(source.quality);
      }
      pushDiagnostic('source_selected', {
        season,
        episode,
        requestedQuality: normalizedQuality,
        resolvedQuality: source.quality || 0,
        sourceUrl: source.sourceUrl
      });
      let outputBlob = await loadCachedOutput(season, episode, source.sourceUrl);
      if (outputBlob) {
        setTaskProgress(0.98);
      } else {
        try {
          outputBlob = await buildOutputBlob(source.sourceUrl, setTaskProgress, {
            season,
            episode,
            requestedQuality: normalizedQuality
          });
          await saveCachedOutput(season, episode, source.sourceUrl, outputBlob);
        } catch (error) {
          pushDiagnostic('prepare_failed', {
            season,
            episode,
            requestedQuality: normalizedQuality,
            message: String(error && error.message ? error.message : error)
          });
          if (!isDownloadError(error)) {
            throw error;
          }
          const refreshedPayload = await options.fetchSourceByEpisode(season, episode, normalizedQuality);
          const refreshedSourceUrl = resolveSourceUrl(refreshedPayload.sourceUrl);
          if (refreshedSourceUrl === source.sourceUrl) {
            throw error;
          }
          const refreshedQuality = parseQualityFromPayload(refreshedPayload.quality, refreshedSourceUrl);
          source = {
            sourceUrl: refreshedSourceUrl,
            quality: refreshedQuality
          };
          task.quality = source.quality;
          if (source.quality > 0) {
            task.qualityLabel = normalizeQualityLabel(source.quality);
          }
          writeSourceUrl(buildSourceCacheKey(season, episode, normalizedQuality), source.sourceUrl);
          if (source.quality > 0) {
            writeSourceUrl(buildSourceCacheKey(season, episode, source.quality), source.sourceUrl);
          }
          outputBlob = await loadCachedOutput(season, episode, source.sourceUrl);
          if (!outputBlob) {
            outputBlob = await buildOutputBlob(source.sourceUrl, setTaskProgress, {
              season,
              episode,
              requestedQuality: normalizedQuality
            });
            await saveCachedOutput(season, episode, source.sourceUrl, outputBlob);
          } else {
            setTaskProgress(0.98);
          }
        }
      }
      setTaskProgress(1);
      return upsertPreparedEntry(season, episode, normalizedQuality, source.sourceUrl, source.quality, outputBlob);
    })().finally(() => {
      tasks.delete(key);
    });
    tasks.set(key, task);
    return task;
  }
  function prepareLadder(season, episode) {
    const bootstrapTask = prepareEpisodeAtQuality(season, episode, bootstrapQuality);
    const maxTaskPromise = bootstrapTask.promise.then(() => prepareEpisodeAtQuality(season, episode, 'max').promise);
    return {
      bootstrapTask,
      maxTaskPromise
    };
  }
  function trimPreparedEntries(current, next) {
    const keep = new Set();
    const qualityKeys = [bootstrapQuality, 'max'];
    for (const target of [current, next]) {
      if (!target) {
        continue;
      }
      for (const quality of qualityKeys) {
        keep.add(buildTaskKey(target.season, target.episode, quality));
      }
    }
    for (const [key, value] of prepared.entries()) {
      if (!keep.has(key)) {
        if (value && value.blobUrl) {
          URL.revokeObjectURL(value.blobUrl);
        }
        prepared.delete(key);
      }
    }
  }
  function preloadEpisodeAtQuality(season, episode, quality = bootstrapQuality) {
    const key = buildTaskKey(season, episode, quality);
    if (prepared.has(key) || tasks.has(key)) {
      return;
    }
    const task = prepareEpisodeAtQuality(season, episode, quality);
    task.promise.catch(() => {
    });
  }
  function preloadEpisode(season, episode) {
    preloadEpisodeAtQuality(season, episode, bootstrapQuality);
  }
  function isPreparedAtQuality(season, episode, quality = 'max') {
    return prepared.has(buildTaskKey(season, episode, quality));
  }
  function warmup() {
    void warmupFfmpeg().catch(() => {
    });
  }
  return {
    prepareEpisodeAtQuality,
    prepareLadder,
    preloadEpisode,
    preloadEpisodeAtQuality,
    isPreparedAtQuality,
    trimPreparedEntries,
    primeSourcesFromBatch,
    warmup,
    getDiagnosticsSnapshot
  };
}

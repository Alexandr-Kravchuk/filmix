import { remuxEnglishTrack, warmupFfmpeg } from './ffmpeg-engine.js';
import { readSourceUrl, writeSourceUrl, writeSourceUrls } from './source-cache.js';

const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const OUTPUT_CACHE_NAME = 'filmix-en-track-cache-v1';

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

export function createTaskQueue(options) {
  const prepared = new Map();
  const tasks = new Map();
  function getCacheKey(sourceUrl) {
    return `https://filmix-cache.local/en-track/${encodeURIComponent(sourceUrl)}`;
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
    return concatChunks(chunks, received);
  }
  function upsertPreparedEntry(season, episode, sourceUrl, outputBytes) {
    const key = buildEpisodeKey(season, episode);
    const oldEntry = prepared.get(key);
    if (oldEntry && oldEntry.blobUrl) {
      URL.revokeObjectURL(oldEntry.blobUrl);
    }
    const blobUrl = URL.createObjectURL(new Blob([outputBytes], { type: 'video/mp4' }));
    const entry = { key, season, episode, sourceUrl, playUrl: blobUrl, blobUrl };
    prepared.set(key, entry);
    return entry;
  }
  async function resolveSourceForEpisode(season, episode) {
    const key = buildEpisodeKey(season, episode);
    const cachedSource = readSourceUrl(key);
    if (cachedSource) {
      return resolveSourceUrl(cachedSource);
    }
    const payload = await options.fetchSourceByEpisode(season, episode);
    const sourceUrl = resolveSourceUrl(payload.sourceUrl);
    writeSourceUrl(key, sourceUrl);
    return sourceUrl;
  }
  async function primeSourcesFromBatch(season, episodes) {
    const normalizedEpisodes = Array.from(new Set((Array.isArray(episodes) ? episodes : [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isFinite(value) && value > 0)));
    if (!normalizedEpisodes.length) {
      return;
    }
    try {
      const payload = await options.fetchSourceBatch(season, normalizedEpisodes);
      const entries = [];
      for (const item of Array.isArray(payload && payload.items) ? payload.items : []) {
        const episode = Number.parseInt(String(item.episode || ''), 10);
        if (!Number.isFinite(episode) || episode <= 0 || typeof item.sourceUrl !== 'string') {
          continue;
        }
        entries.push({
          episodeKey: buildEpisodeKey(season, episode),
          sourceUrl: resolveSourceUrl(item.sourceUrl)
        });
      }
      if (entries.length) {
        writeSourceUrls(entries);
      }
    } catch {
    }
  }
  function getOrCreateTask(season, episode) {
    const key = buildEpisodeKey(season, episode);
    const existing = tasks.get(key);
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
      if (prepared.has(key)) {
        task.progress = 1;
        return prepared.get(key);
      }
      setTaskProgress(0.02);
      const sourceUrl = await resolveSourceForEpisode(season, episode);
      let outputBytes = await loadCachedOutput(sourceUrl);
      if (outputBytes) {
        setTaskProgress(0.98);
      } else {
        const sourceBytes = await downloadSourceFile(sourceUrl, (downloadProgress) => setTaskProgress(0.05 + downloadProgress * 0.5));
        outputBytes = await remuxEnglishTrack(sourceBytes, (ffmpegProgress) => setTaskProgress(0.6 + ffmpegProgress * 0.38));
        await saveCachedOutput(sourceUrl, outputBytes);
      }
      setTaskProgress(1);
      return upsertPreparedEntry(season, episode, sourceUrl, outputBytes);
    })().finally(() => {
      tasks.delete(key);
    });
    tasks.set(key, task);
    return task;
  }
  function trimPreparedEntries(current, next) {
    const keep = new Set();
    if (current) {
      keep.add(buildEpisodeKey(current.season, current.episode));
    }
    if (next) {
      keep.add(buildEpisodeKey(next.season, next.episode));
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
  function preloadEpisode(season, episode) {
    const key = buildEpisodeKey(season, episode);
    if (prepared.has(key) || tasks.has(key)) {
      return;
    }
    const task = getOrCreateTask(season, episode);
    task.promise.catch(() => {
    });
  }
  function warmup() {
    void warmupFfmpeg().catch(() => {
    });
  }
  return {
    getOrCreateTask,
    preloadEpisode,
    trimPreparedEntries,
    primeSourcesFromBatch,
    warmup
  };
}

import './styles.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const DEFAULT_SOURCE_URL = 'https://nl201.cdnsqu.com/dl/0b339658edb5aabe82533732ae06a196/paw.patrol.2013.dub.ukr/s05e11_480.mp4?user=1093269';
const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const OUTPUT_CACHE_NAME = 'filmix-en-track-cache-v1';

const elements = {
  status: document.getElementById('status'),
  video: document.getElementById('video'),
  sourceUrl: document.getElementById('source-url'),
  prepareButton: document.getElementById('prepare-btn'),
  progress: document.getElementById('progress')
};

let outputBlobUrl = '';
let coreAssetPromise = null;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

function setBusy(isBusy) {
  elements.prepareButton.disabled = isBusy;
  elements.sourceUrl.disabled = isBusy;
}

function setProgress(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  elements.progress.value = normalized;
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

async function getCoreAssets() {
  if (!coreAssetPromise) {
    coreAssetPromise = Promise.all([
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
    ]).then(([coreURL, wasmURL]) => ({ coreURL, wasmURL }));
  }
  return coreAssetPromise;
}

function getCacheKey(sourceUrl) {
  return `https://filmix-cache.local/en-track/${encodeURIComponent(sourceUrl)}`;
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

async function downloadSourceFile(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
  if (Number.isFinite(total) && total > MAX_SOURCE_BYTES) {
    throw new Error(`Source is too large (${Math.round(total / (1024 * 1024))}MB) for frontend-only processing`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      received += value.length;
      if (total > 0) {
        setProgress((received / total) * 0.35);
      }
      if (received > MAX_SOURCE_BYTES) {
        throw new Error(`Downloaded stream exceeded ${Math.round(MAX_SOURCE_BYTES / (1024 * 1024))}MB limit`);
      }
    }
  }
  return concatChunks(chunks, received);
}

function createFfmpegSession() {
  const ffmpeg = new FFmpeg();
  let lastError = '';
  const logTail = [];
  const onLog = ({ type, message }) => {
    const text = String(message || '').trim();
    if (text) {
      logTail.push(text);
      if (logTail.length > 40) {
        logTail.shift();
      }
    }
    if (type === 'fferr') {
      lastError = text;
    }
  };
  const onProgress = ({ progress }) => {
    setProgress(0.45 + (Number(progress) || 0) * 0.5);
  };
  ffmpeg.on('log', onLog);
  ffmpeg.on('progress', onProgress);
  return {
    ffmpeg,
    getLastError() {
      return lastError;
    },
    getDebugLog() {
      return logTail.join(' | ');
    },
    dispose() {
      try {
        ffmpeg.off('log', onLog);
        ffmpeg.off('progress', onProgress);
      } catch {
      }
      try {
        ffmpeg.terminate();
      } catch {
      }
    }
  };
}

async function remuxWithFallbackMappings(ffmpeg, getLastError, getDebugLog) {
  const mappings = [
    ['-map', '0:v:0', '-map', '0:a:m:language:eng'],
    ['-map', '0:v:0', '-map', '0:a:1'],
    ['-map', '0:v:0', '-map', '0:a:0']
  ];
  let lastCode = -1;
  for (const mapping of mappings) {
    const code = await ffmpeg.exec([
      '-y',
      '-i',
      'input.mp4',
      ...mapping,
      '-c',
      'copy',
      '-movflags',
      'faststart',
      'output.mp4'
    ]);
    lastCode = code;
    if (code === 0) {
      return await ffmpeg.readFile('output.mp4');
    }
    try {
      await ffmpeg.deleteFile('output.mp4');
    } catch {
    }
  }
  const details = getLastError() || getDebugLog() || `ffmpeg exit code ${lastCode}`;
  throw new Error(details);
}

async function cleanupSessionFiles(ffmpeg) {
  const files = ['input.mp4', 'output.mp4', 'probe.json'];
  for (const fileName of files) {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
    }
  }
}

async function buildEnglishTrack(sourceBytes) {
  const session = createFfmpegSession();
  try {
    setStatus('Loading ffmpeg core...');
    const { coreURL, wasmURL } = await getCoreAssets();
    await session.ffmpeg.load({ coreURL, wasmURL });
    setStatus('Building English track...');
    await session.ffmpeg.writeFile('input.mp4', sourceBytes);
    return await remuxWithFallbackMappings(session.ffmpeg, session.getLastError, session.getDebugLog);
  } finally {
    await cleanupSessionFiles(session.ffmpeg);
    session.dispose();
  }
}

function applyOutput(outputBytes) {
  if (outputBlobUrl) {
    URL.revokeObjectURL(outputBlobUrl);
  }
  outputBlobUrl = URL.createObjectURL(new Blob([outputBytes], { type: 'video/mp4' }));
  elements.video.src = outputBlobUrl;
  elements.video.load();
  setProgress(1);
  setStatus('English track is ready');
}

async function prepareEnglishTrack() {
  const sourceUrl = String(elements.sourceUrl.value || '').trim();
  if (!sourceUrl) {
    throw new Error('Source URL is required');
  }
  setBusy(true);
  setProgress(0);
  try {
    setStatus('Checking prepared cache...');
    const cached = await loadCachedOutput(sourceUrl);
    if (cached) {
      setProgress(0.95);
      applyOutput(cached);
      return;
    }
    setStatus('Downloading source file...');
    const sourceBytes = await downloadSourceFile(sourceUrl);
    const outputBytes = await buildEnglishTrack(sourceBytes);
    await saveCachedOutput(sourceUrl, outputBytes);
    applyOutput(outputBytes);
  } finally {
    setBusy(false);
  }
}

async function onPrepareClick() {
  try {
    await prepareEnglishTrack();
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot extract English track from source';
    setStatus(message, true);
    setProgress(0);
  }
}

function init() {
  elements.sourceUrl.value = DEFAULT_SOURCE_URL;
  elements.prepareButton.addEventListener('click', onPrepareClick);
  setStatus('Click "Prepare English"');
}

init();

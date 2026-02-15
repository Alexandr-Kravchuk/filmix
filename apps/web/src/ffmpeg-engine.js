import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

const state = {
  ffmpeg: null,
  queue: Promise.resolve(),
  loaded: false,
  coreAssetsPromise: null,
  activeProgress: null,
  lastError: '',
  logTail: []
};

function getCoreAssets() {
  if (!state.coreAssetsPromise) {
    state.coreAssetsPromise = Promise.all([
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
    ]).then(([coreURL, wasmURL]) => ({ coreURL, wasmURL }));
  }
  return state.coreAssetsPromise;
}
function handleLog(event) {
  const type = String(event && event.type ? event.type : '');
  const message = String(event && event.message ? event.message : '').trim();
  if (!message) {
    return;
  }
  state.logTail.push(message);
  if (state.logTail.length > 100) {
    state.logTail.shift();
  }
  if (type === 'fferr') {
    state.lastError = message;
  }
}
function handleProgress(event) {
  if (!state.activeProgress) {
    return;
  }
  const value = Math.max(0, Math.min(1, Number(event && event.progress ? event.progress : 0)));
  state.activeProgress(value);
}
function ensureFfmpegInstance() {
  if (state.ffmpeg) {
    return state.ffmpeg;
  }
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', handleLog);
  ffmpeg.on('progress', handleProgress);
  state.ffmpeg = ffmpeg;
  return ffmpeg;
}
async function ensureLoaded(onProgress) {
  const ffmpeg = ensureFfmpegInstance();
  if (state.loaded) {
    return ffmpeg;
  }
  const assets = await getCoreAssets();
  if (onProgress) {
    onProgress(0.05);
  }
  await ffmpeg.load(assets);
  state.loaded = true;
  if (onProgress) {
    onProgress(0.15);
  }
  return ffmpeg;
}
function enqueue(job) {
  const next = state.queue.then(job, job);
  state.queue = next.catch(() => {
  });
  return next;
}
async function cleanupFiles(ffmpeg) {
  for (const fileName of ['input.mp4', 'output.mp4']) {
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
    }
  }
}

export function warmupFfmpeg() {
  return enqueue(async () => {
    await ensureLoaded();
    return true;
  });
}
export function remuxEnglishTrack(sourceBytes, onProgress) {
  return enqueue(async () => {
    const ffmpeg = await ensureLoaded(onProgress);
    state.lastError = '';
    state.activeProgress = onProgress ? (value) => onProgress(0.2 + value * 0.8) : null;
    try {
      await ffmpeg.writeFile('input.mp4', sourceBytes);
      const code = await ffmpeg.exec([
        '-y',
        '-i',
        'input.mp4',
        '-map',
        '0:v:0',
        '-map',
        '0:a:m:language:eng',
        '-c',
        'copy',
        '-movflags',
        'faststart',
        'output.mp4'
      ]);
      if (code !== 0) {
        const details = state.lastError || state.logTail.join(' | ') || `ffmpeg exit code ${code}`;
        throw new Error(`English track is not available in this source. ${details}`);
      }
      return await ffmpeg.readFile('output.mp4');
    } finally {
      state.activeProgress = null;
      await cleanupFiles(ffmpeg);
    }
  });
}

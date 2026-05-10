import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const INPUT_MOUNT_POINT = '/in';
const INPUT_MOUNT_FILE = 'input.mp4';
const FS_TYPE_WORKERFS = 'WORKERFS';

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
async function cleanupSegmentFiles(ffmpeg) {
  let names = [];
  try {
    const entries = await ffmpeg.listDir('/');
    names = entries
      .filter((entry) => entry && !entry.isDir && /^seg_\d+\.mp4$/.test(String(entry.name || '')))
      .map((entry) => entry.name);
  } catch {
  }
  for (const name of names) {
    try {
      await ffmpeg.deleteFile(name);
    } catch {
    }
  }
  try {
    await ffmpeg.deleteFile('input.mp4');
  } catch {
  }
}
async function safeUnmountInput(ffmpeg) {
  try {
    await ffmpeg.unmount(INPUT_MOUNT_POINT);
  } catch {
  }
}
async function safeMountInputBlob(ffmpeg, blob) {
  try {
    await ffmpeg.unmount(INPUT_MOUNT_POINT);
  } catch {
  }
  try {
    await ffmpeg.createDir(INPUT_MOUNT_POINT);
  } catch {
  }
  await ffmpeg.mount(
    FS_TYPE_WORKERFS,
    { blobs: [{ name: INPUT_MOUNT_FILE, data: blob }] },
    INPUT_MOUNT_POINT
  );
}
function resetFfmpegState(ffmpeg) {
  if (state.ffmpeg !== ffmpeg) {
    return;
  }
  state.ffmpeg = null;
  state.loaded = false;
  state.lastError = '';
  state.logTail = [];
  if (ffmpeg && typeof ffmpeg.terminate === 'function') {
    try {
      ffmpeg.terminate();
    } catch {
    }
  }
}

export function getFfmpegLogTail(limit = 30) {
  const safeLimit = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 30;
  return state.logTail.slice(-safeLimit);
}
export function getFfmpegLastError() {
  return state.lastError || '';
}
export function warmupFfmpeg() {
  return enqueue(async () => {
    await ensureLoaded();
    return true;
  });
}
export function segmentEnglishTrackFromBlob(sourceBlob, onProgress, options = {}) {
  const releaseAfter = options && options.releaseAfter === true;
  const segmentSeconds = Number.isFinite(Number(options && options.segmentSeconds)) && Number(options.segmentSeconds) > 0
    ? Math.floor(Number(options.segmentSeconds))
    : 1200;
  return enqueue(async () => {
    const ffmpeg = await ensureLoaded(onProgress);
    state.lastError = '';
    state.activeProgress = onProgress ? (value) => onProgress(0.2 + value * 0.78) : null;
    let mounted = false;
    try {
      await cleanupSegmentFiles(ffmpeg);
      await safeMountInputBlob(ffmpeg, sourceBlob);
      mounted = true;
      const inputPath = `${INPUT_MOUNT_POINT}/${INPUT_MOUNT_FILE}`;
      const code = await ffmpeg.exec([
        '-y',
        '-i',
        inputPath,
        '-map',
        '0:v:0',
        '-map',
        '0:a:m:language:eng',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(segmentSeconds),
        '-reset_timestamps',
        '1',
        '-movflags',
        '+faststart',
        'seg_%03d.mp4'
      ]);
      if (code !== 0) {
        const details = state.lastError || state.logTail.join(' | ') || `ffmpeg exit code ${code}`;
        throw new Error(`English track is not available in this source. ${details}`);
      }
      const entries = await ffmpeg.listDir('/');
      const segmentNames = entries
        .filter((entry) => entry && !entry.isDir && /^seg_\d+\.mp4$/.test(String(entry.name || '')))
        .map((entry) => entry.name)
        .sort();
      if (!segmentNames.length) {
        throw new Error('English track segmenting produced no output files');
      }
      const segments = [];
      for (const name of segmentNames) {
        const data = await ffmpeg.readFile(name);
        segments.push(new Blob([data], { type: 'video/mp4' }));
        try {
          await ffmpeg.deleteFile(name);
        } catch {
        }
      }
      return {
        segments,
        segmentSeconds
      };
    } finally {
      if (mounted) {
        await safeUnmountInput(ffmpeg);
      }
      state.activeProgress = null;
      await cleanupSegmentFiles(ffmpeg);
      if (releaseAfter) {
        resetFfmpegState(ffmpeg);
      }
    }
  });
}
export function segmentEnglishTrack(sourceBytes, onProgress, options = {}) {
  const releaseAfter = options && options.releaseAfter === true;
  const segmentSeconds = Number.isFinite(Number(options && options.segmentSeconds)) && Number(options.segmentSeconds) > 0
    ? Math.floor(Number(options.segmentSeconds))
    : 1200;
  return enqueue(async () => {
    const ffmpeg = await ensureLoaded(onProgress);
    state.lastError = '';
    state.activeProgress = onProgress ? (value) => onProgress(0.2 + value * 0.78) : null;
    try {
      await cleanupSegmentFiles(ffmpeg);
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
        '-f',
        'segment',
        '-segment_time',
        String(segmentSeconds),
        '-reset_timestamps',
        '1',
        '-movflags',
        '+faststart',
        'seg_%03d.mp4'
      ]);
      if (code !== 0) {
        const details = state.lastError || state.logTail.join(' | ') || `ffmpeg exit code ${code}`;
        throw new Error(`English track is not available in this source. ${details}`);
      }
      const entries = await ffmpeg.listDir('/');
      const segmentNames = entries
        .filter((entry) => entry && !entry.isDir && /^seg_\d+\.mp4$/.test(String(entry.name || '')))
        .map((entry) => entry.name)
        .sort();
      if (!segmentNames.length) {
        throw new Error('English track segmenting produced no output files');
      }
      const segments = [];
      for (const name of segmentNames) {
        const data = await ffmpeg.readFile(name);
        segments.push(new Blob([data], { type: 'video/mp4' }));
        try {
          await ffmpeg.deleteFile(name);
        } catch {
        }
      }
      return {
        segments,
        segmentSeconds
      };
    } finally {
      state.activeProgress = null;
      await cleanupSegmentFiles(ffmpeg);
      if (releaseAfter) {
        resetFfmpegState(ffmpeg);
      }
    }
  });
}
export function remuxEnglishTrack(sourceBytes, onProgress, options = {}) {
  const releaseAfter = options && options.releaseAfter === true;
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
      if (releaseAfter) {
        resetFfmpegState(ffmpeg);
      }
    }
  });
}

import './styles.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const DEFAULT_SOURCE_URL = 'https://nl201.cdnsqu.com/dl/0b339658edb5aabe82533732ae06a196/paw.patrol.2013.dub.ukr/s05e11_480.mp4?user=1093269';
const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';

const elements = {
  status: document.getElementById('status'),
  video: document.getElementById('video'),
  sourceUrl: document.getElementById('source-url'),
  prepareButton: document.getElementById('prepare-btn'),
  progress: document.getElementById('progress')
};

const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;
let outputBlobUrl = '';

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

async function downloadSourceFile(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const total = Number.parseInt(response.headers.get('content-length') || '0', 10);
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
        setProgress((received / total) * 0.4);
      }
    }
  }
  return concatChunks(chunks, received);
}

async function loadFfmpeg() {
  if (ffmpegLoaded) {
    return;
  }
  setStatus('Loading ffmpeg core...');
  const coreURL = await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });
  ffmpeg.on('progress', ({ progress }) => {
    setProgress(0.4 + (Number(progress) || 0) * 0.6);
  });
  ffmpegLoaded = true;
}

async function remuxEnglish() {
  const attempts = [
    ['-map', '0:v:0', '-map', '0:a:m:language:eng'],
    ['-map', '0:v:0', '-map', '0:a:1'],
    ['-map', '0:v:0', '-map', '0:a:0']
  ];
  for (const mapping of attempts) {
    await ffmpeg.exec(['-y', '-i', 'input.mp4', ...mapping, '-c', 'copy', '-movflags', 'faststart', 'output.mp4']).then(
      () => true,
      async () => {
        try {
          await ffmpeg.deleteFile('output.mp4');
        } catch {
        }
        return false;
      }
    );
    try {
      await ffmpeg.readFile('output.mp4');
      return;
    } catch {
    }
  }
  throw new Error('Cannot extract English track from source');
}

async function prepareEnglishTrack() {
  const sourceUrl = String(elements.sourceUrl.value || '').trim();
  if (!sourceUrl) {
    throw new Error('Source URL is required');
  }
  setBusy(true);
  setProgress(0);
  await loadFfmpeg();
  setStatus('Downloading source file...');
  const sourceBytes = await downloadSourceFile(sourceUrl);
  setStatus('Building English track...');
  await ffmpeg.writeFile('input.mp4', sourceBytes);
  await remuxEnglish();
  const outputBytes = await ffmpeg.readFile('output.mp4');
  try {
    await ffmpeg.deleteFile('input.mp4');
    await ffmpeg.deleteFile('output.mp4');
  } catch {
  }
  if (outputBlobUrl) {
    URL.revokeObjectURL(outputBlobUrl);
  }
  outputBlobUrl = URL.createObjectURL(new Blob([outputBytes], { type: 'video/mp4' }));
  elements.video.src = outputBlobUrl;
  elements.video.load();
  setProgress(1);
  setStatus('English track is ready');
  setBusy(false);
}

async function onPrepareClick() {
  try {
    await prepareEnglishTrack();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
    setProgress(0);
  }
}

function init() {
  elements.sourceUrl.value = DEFAULT_SOURCE_URL;
  elements.prepareButton.addEventListener('click', onPrepareClick);
  setStatus('Click "Prepare English"');
}

init();

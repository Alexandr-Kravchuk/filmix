import './styles.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { fetchSource, getApiBaseUrl } from './api.js';

const DEFAULT_SOURCE_URL = 'https://nl201.cdnsqu.com/s/FHwczVImqnkP-n6cpV8rh3tEFBQUFBSld1TUVFUmRCRUdBS0RWb1pBQg.eMCfInpkOUel2UJPaTlFZAZtQ6sG8UHaK0gk-g/paw.patrol.2013.dub.ukr/s05e11_480.mp4';
const CORE_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const OUTPUT_CACHE_NAME = 'filmix-en-track-cache-v1';
const FIXED_SEASON = 5;
const FIXED_EPISODE = 11;
const FIXED_QUALITY = 480;
const TRANSLATION_PATTERN = /ukr|укра/i;
const DECODE_CONFIG = Object.freeze({
  file3Separator: ':<:',
  bk0: '2owKDUoGzsuLNEyhNx',
  bk1: '19n1iKBr89ubskS5zT',
  bk2: 'IDaBt08C9Wf7lYr0eH',
  bk3: 'lNjI9V5U1gMnsxt4Qr',
  bk4: 'o9wPt0ii42GWeS7L7A'
});

const elements = {
  status: document.getElementById('status'),
  video: document.getElementById('video'),
  sourceUrl: document.getElementById('source-url'),
  backendButton: document.getElementById('backend-btn'),
  bookmarkletLink: document.getElementById('bookmarklet-link'),
  pasteButton: document.getElementById('paste-btn'),
  playerDataFile: document.getElementById('player-data-file'),
  extractButton: document.getElementById('extract-btn'),
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
  elements.backendButton.disabled = isBusy;
  elements.extractButton.disabled = isBusy;
  elements.pasteButton.disabled = isBusy;
  elements.playerDataFile.disabled = isBusy;
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

function encodeUtf8ToBase64(value) {
  const normalized = encodeURIComponent(String(value || '')).replace(/%([0-9A-F]{2})/g, (match, code) =>
    String.fromCharCode(Number.parseInt(code, 16))
  );
  return btoa(normalized);
}

function decodeBase64ToUtf8(value) {
  const binary = atob(String(value || ''));
  const percentEncoded = binary
    .split('')
    .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .join('');
  return decodeURIComponent(percentEncoded);
}

function decodePlayerjsValue(encodedValue) {
  const source = String(encodedValue || '').trim();
  if (!source.startsWith('#2')) {
    return source;
  }
  let payload = source.slice(2);
  for (let index = 4; index >= 0; index -= 1) {
    const key = `bk${index}`;
    const blockValue = DECODE_CONFIG[key];
    if (!blockValue) {
      continue;
    }
    const marker = `${DECODE_CONFIG.file3Separator}${encodeUtf8ToBase64(blockValue)}`;
    payload = payload.split(marker).join('');
  }
  return decodeBase64ToUtf8(payload);
}

function parseEpisodeId(idValue) {
  const match = String(idValue || '').match(/^s0*(\d+)e0*(\d+)$/i);
  if (!match) {
    return null;
  }
  const season = Number.parseInt(match[1], 10);
  const episode = Number.parseInt(match[2], 10);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    return null;
  }
  return { season, episode };
}

function parseQualityVariants(fileValue) {
  return String(fileValue || '')
    .split(',')
    .map((chunk) => chunk.trim())
    .map((chunk) => {
      const match = chunk.match(/^\[(\d+)p\](https?:.+)$/i);
      if (!match) {
        return null;
      }
      return {
        quality: Number.parseInt(match[1], 10),
        url: match[2]
      };
    })
    .filter(Boolean);
}

function pickVariant(variants, preferredQuality) {
  const exact = variants.find((item) => item.quality === preferredQuality);
  if (exact) {
    return exact;
  }
  return [...variants].sort((a, b) => b.quality - a.quality)[0] || null;
}

function pickTranslation(videoTranslations) {
  const entries = Object.entries(videoTranslations || {}).filter((entry) =>
    typeof entry[1] === 'string' && entry[1].startsWith('#2')
  );
  if (!entries.length) {
    return null;
  }
  const preferred = entries.find(([name]) => TRANSLATION_PATTERN.test(name));
  return preferred || entries[0];
}

async function resolveSourceFromPlayerDataText(text, onStatusChange) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || '').trim());
  } catch (error) {
    throw new Error(`Invalid player-data JSON: ${error.message}`);
  }
  const translations = parsed && parsed.message && parsed.message.translations && parsed.message.translations.video;
  if (!translations || typeof translations !== 'object') {
    throw new Error('player-data file does not contain message.translations.video');
  }
  const translation = pickTranslation(translations);
  if (!translation) {
    throw new Error('No decodable translation entry found in player-data');
  }
  const playlistUrl = decodePlayerjsValue(translation[1]);
  if (!playlistUrl.startsWith('http')) {
    throw new Error('Decoded playlist URL is invalid');
  }
  onStatusChange('Downloading playlist...');
  const playlistResponse = await fetch(playlistUrl, {
    headers: {
      Accept: 'text/plain,application/json,*/*'
    }
  });
  if (!playlistResponse.ok) {
    throw new Error(`Playlist request failed: HTTP ${playlistResponse.status}`);
  }
  const playlistBody = await playlistResponse.text();
  const decodedPlaylist = decodePlayerjsValue(playlistBody);
  let playlistJson;
  try {
    playlistJson = JSON.parse(decodedPlaylist);
  } catch (error) {
    throw new Error(`Playlist payload is invalid: ${error.message}`);
  }
  if (!Array.isArray(playlistJson)) {
    throw new Error('Playlist payload has unsupported structure');
  }
  for (const seasonEntry of playlistJson) {
    const folder = Array.isArray(seasonEntry && seasonEntry.folder) ? seasonEntry.folder : [];
    for (const episodeEntry of folder) {
      const parsedId = parseEpisodeId(episodeEntry ? episodeEntry.id : '');
      if (!parsedId) {
        continue;
      }
      if (parsedId.season !== FIXED_SEASON || parsedId.episode !== FIXED_EPISODE) {
        continue;
      }
      const variants = parseQualityVariants(episodeEntry.file);
      const picked = pickVariant(variants, FIXED_QUALITY);
      if (picked && picked.url) {
        return picked.url;
      }
    }
  }
  throw new Error(`Episode s${String(FIXED_SEASON).padStart(2, '0')}e${String(FIXED_EPISODE).padStart(2, '0')} was not found in playlist`);
}

function buildFilmixBookmarkletHref() {
  const script = `(async()=>{try{const match=location.pathname.match(/\\/(\\d+)-[^/]+\\.html$/)||location.pathname.match(/\\/(\\d+)(?:\\/)?$/);const postId=(match&&match[1])||new URLSearchParams(location.search).get('post_id')||'';if(!postId){alert('Filmix post_id not found on this page');return;}const body=new URLSearchParams({post_id:postId,showfull:'true'}).toString();const response=await fetch('/api/movies/player-data',{method:'POST',headers:{accept:'application/json, text/plain, */*','content-type':'application/x-www-form-urlencoded; charset=UTF-8','x-requested-with':'XMLHttpRequest'},credentials:'include',body});if(!response.ok){throw new Error('HTTP '+response.status);}const text=await response.text();try{await navigator.clipboard.writeText(text);alert('player-data copied. Open your Pages site and click Paste player-data from clipboard.');}catch(error){const blob=new Blob([text],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='player-data-'+postId+'.json';document.body.appendChild(link);link.click();setTimeout(()=>{URL.revokeObjectURL(link.href);link.remove();},500);alert('Clipboard blocked. File downloaded instead.');}}catch(error){alert('player-data request failed: '+(error&&error.message?error.message:error));}})();`;
  return `javascript:${script}`;
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
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('video/') && !contentType.includes('application/octet-stream')) {
    throw new Error(`Source URL is invalid or expired: expected video, got ${contentType}. Refresh URL from player-data file.`);
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
  if (received === 0) {
    throw new Error('Source URL returned empty response body. Refresh URL from player-data file.');
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
  if (code === 0) {
    return await ffmpeg.readFile('output.mp4');
  }
  const details = getLastError() || getDebugLog() || `ffmpeg exit code ${code}`;
  throw new Error(`English track is not available in this source. ${details}`);
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

async function onExtractClick() {
  const file = elements.playerDataFile.files && elements.playerDataFile.files[0];
  if (!file) {
    setStatus('Select player-data text/json file first', true);
    return;
  }
  setBusy(true);
  setProgress(0);
  try {
    setStatus('Reading player-data...');
    const text = await file.text();
    const sourceUrl = await resolveSourceFromPlayerDataText(text, (status) => setStatus(status));
    elements.sourceUrl.value = sourceUrl;
    setStatus('Source URL refreshed from player-data');
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot extract source from player-data';
    setStatus(message, true);
  } finally {
    setBusy(false);
    setProgress(0);
  }
}

async function onPasteClick() {
  if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
    setStatus('Clipboard API is not available in this browser', true);
    return;
  }
  setBusy(true);
  setProgress(0);
  try {
    setStatus('Reading player-data from clipboard...');
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      throw new Error('Clipboard is empty');
    }
    const sourceUrl = await resolveSourceFromPlayerDataText(text, (status) => setStatus(status));
    elements.sourceUrl.value = sourceUrl;
    setStatus('Source URL refreshed from clipboard');
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot read player-data from clipboard';
    setStatus(message, true);
  } finally {
    setBusy(false);
    setProgress(0);
  }
}
async function onBackendClick() {
  setBusy(true);
  setProgress(0);
  try {
    setStatus('Loading source URL from backend...');
    const payload = await fetchSource();
    const resolved = String(payload.sourceUrl || payload.playUrl || '').trim();
    if (!resolved) {
      throw new Error('Backend returned empty source URL');
    }
    const sourceUrl = resolved.startsWith('http://') || resolved.startsWith('https://')
      ? resolved
      : new URL(resolved, getApiBaseUrl()).toString();
    elements.sourceUrl.value = sourceUrl;
    const origin = payload.origin ? ` (${payload.origin})` : '';
    setStatus(`Source URL refreshed from backend${origin}`);
  } catch (error) {
    const message = error && error.message ? error.message : 'Cannot load source URL from backend';
    setStatus(message, true);
  } finally {
    setBusy(false);
    setProgress(0);
  }
}

function init() {
  elements.sourceUrl.value = DEFAULT_SOURCE_URL;
  elements.bookmarkletLink.href = buildFilmixBookmarkletHref();
  elements.prepareButton.addEventListener('click', onPrepareClick);
  elements.backendButton.addEventListener('click', onBackendClick);
  elements.extractButton.addEventListener('click', onExtractClick);
  elements.pasteButton.addEventListener('click', onPasteClick);
  setStatus('Refresh URL from backend, then click "Prepare English"');
}

init();

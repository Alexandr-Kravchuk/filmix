import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveSourceUrl } from './proxy-service.js';

const buildLocks = new Map();

function parseProbeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Failed to parse ffprobe output');
  }
}

function isEnglishLanguage(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === 'eng' || normalized === 'en' || normalized.startsWith('en-');
}

function buildSourceKey(sourceUrl) {
  return crypto.createHash('sha256').update(sourceUrl).digest('hex');
}

function getPathsForSource(sourceUrl, cacheDir) {
  const key = buildSourceKey(sourceUrl);
  return {
    originalPath: path.join(cacheDir, `${key}.orig.mp4`),
    englishPath: path.join(cacheDir, `${key}.en.mp4`)
  };
}

function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(bin, args);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    proc.on('error', (error) => {
      reject(new Error(`${bin} failed: ${error.message}`));
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${bin} exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function downloadSourceToFile(sourceUrl, targetPath, options = {}) {
  const headers = {};
  if (options.userAgent) {
    headers['User-Agent'] = options.userAgent;
  }
  if (options.referer) {
    headers.Referer = options.referer;
  }
  const response = await fetch(sourceUrl, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download source: HTTP ${response.status}`);
  }
  const tempPath = `${targetPath}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  await rename(tempPath, targetPath);
}

export function pickAudioStreamIndex(streams) {
  const audioStreams = Array.isArray(streams) ? streams.filter((stream) => stream && stream.codec_type === 'audio') : [];
  if (!audioStreams.length) {
    throw new Error('No audio stream in source');
  }
  const english = audioStreams.find((stream) => isEnglishLanguage(stream.tags && stream.tags.language));
  if (english && Number.isInteger(english.index)) {
    return english.index;
  }
  const first = audioStreams[0];
  if (!Number.isInteger(first.index)) {
    throw new Error('Audio stream index is invalid');
  }
  return first.index;
}

async function detectAudioStreamIndex(inputPath, options = {}) {
  const ffprobeBin = options.ffprobeBin || 'ffprobe';
  const args = ['-v', 'error', '-show_entries', 'stream=index,codec_type:stream_tags=language', '-of', 'json', inputPath];
  const probe = await runProcess(ffprobeBin, args);
  const parsed = parseProbeJson(probe.stdout);
  return pickAudioStreamIndex(parsed.streams || []);
}

async function buildEnglishFile(originalPath, englishPath, options = {}) {
  const ffmpegBin = options.ffmpegBin || 'ffmpeg';
  const audioStreamIndex = await detectAudioStreamIndex(originalPath, {
    ffprobeBin: options.ffprobeBin
  });
  const tempPath = `${englishPath}.part`;
  const args = ['-v', 'error', '-y', '-i', originalPath, '-map', '0:v:0', '-map', `0:${audioStreamIndex}`, '-c', 'copy', '-movflags', 'faststart', '-f', 'mp4', tempPath];
  await runProcess(ffmpegBin, args);
  await rename(tempPath, englishPath);
}

async function ensureEnglishFile(sourceUrl, options = {}) {
  const cacheDir = options.cacheDir || '/tmp/filmix-cache';
  await mkdir(cacheDir, { recursive: true });
  const paths = getPathsForSource(sourceUrl, cacheDir);
  if (await fileExists(paths.englishPath)) {
    return paths.englishPath;
  }
  if (!buildLocks.has(paths.englishPath)) {
    buildLocks.set(paths.englishPath, (async () => {
      try {
        if (!(await fileExists(paths.originalPath))) {
          await downloadSourceToFile(sourceUrl, paths.originalPath, {
            userAgent: options.userAgent,
            referer: options.referer
          });
        }
        await buildEnglishFile(paths.originalPath, paths.englishPath, {
          ffmpegBin: options.ffmpegBin,
          ffprobeBin: options.ffprobeBin
        });
      } catch (error) {
        await unlink(paths.englishPath).catch(() => {});
        throw error;
      } finally {
        buildLocks.delete(paths.englishPath);
      }
    })());
  }
  await buildLocks.get(paths.englishPath);
  return paths.englishPath;
}

async function sendFile(filePath, req, res) {
  const fileStat = await stat(filePath);
  const total = fileStat.size;
  const rangeHeader = String(req.headers.range || '');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'video/mp4');
  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (!match) {
      res.status(416).end();
      return;
    }
    const start = match[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= total) {
      res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      return;
    }
    const length = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(length));
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.status(200);
  res.setHeader('Content-Length', String(total));
  createReadStream(filePath).pipe(res);
}

export async function proxyVideoEnglishAudio(req, res, options = {}) {
  const sourceUrl = resolveSourceUrl(req.query.src);
  const englishPath = await ensureEnglishFile(sourceUrl, {
    cacheDir: options.cacheDir,
    userAgent: options.userAgent,
    referer: options.referer,
    ffmpegBin: options.ffmpegBin,
    ffprobeBin: options.ffprobeBin
  });
  await sendFile(englishPath, req, res);
}

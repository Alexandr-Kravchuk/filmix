import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';

function resolveFfmpegBinary() {
  const fromEnv = String(process.env.FFMPEG_PATH || '').trim();
  if (fromEnv) {
    return fromEnv;
  }
  const fromPackage = ffmpegStatic && typeof ffmpegStatic === 'string' ? ffmpegStatic : ffmpegStatic && ffmpegStatic.default;
  if (fromPackage) {
    return String(fromPackage);
  }
  throw new Error('ffmpeg binary path is not available');
}

function buildHttpHeaderArgs({ userAgent, referer, cookie }) {
  const lines = [];
  if (userAgent) {
    lines.push(`User-Agent: ${userAgent}`);
  }
  if (referer) {
    lines.push(`Referer: ${referer}`);
  }
  if (cookie) {
    lines.push(`Cookie: ${cookie}`);
  }
  if (!lines.length) {
    return [];
  }
  return ['-headers', `${lines.join('\r\n')}\r\n`];
}

function parseDurationFromStderr(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || !Number.isFinite(ss)) {
    return null;
  }
  return hh * 3600 + mm * 60 + ss;
}

export function probeMovieDuration(sourceUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      ...buildHttpHeaderArgs(options),
      '-i', sourceUrl,
      '-c', 'copy',
      '-t', '0.001',
      '-f', 'null',
      '-'
    ];
    const proc = spawn(resolveFfmpegBinary(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let resolved = false;
    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg probe timed out'));
    }, 20000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      reject(error);
    });
    proc.on('close', (code) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeout);
      const duration = parseDurationFromStderr(stderr);
      if (duration === null) {
        const tail = stderr.slice(-400);
        reject(new Error(`Cannot parse duration from ffmpeg (exit ${code}): ${tail}`));
        return;
      }
      resolve({ duration, code });
    });
  });
}

export function spawnEnglishSegmentStream(sourceUrl, options = {}) {
  const start = Number(options.start || 0);
  const duration = Number(options.duration || 0);
  if (!Number.isFinite(start) || start < 0) {
    throw new Error('start must be a non-negative number');
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('duration must be a positive number');
  }
  const audioLanguage = String(options.audioLanguage || 'eng');
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    ...buildHttpHeaderArgs(options),
    '-ss', String(start),
    '-i', sourceUrl,
    '-t', String(duration),
    '-map', '0:v:0',
    '-map', `0:a:m:language:${audioLanguage}`,
    '-c', 'copy',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ];
  const proc = spawn(resolveFfmpegBinary(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 8000) {
      stderr = stderr.slice(-8000);
    }
  });
  proc.getStderr = () => stderr;
  return proc;
}

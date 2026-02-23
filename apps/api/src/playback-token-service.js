import crypto from 'node:crypto';

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}
function fromBase64Url(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const mod = normalized.length % 4;
  const padded = mod ? normalized + '='.repeat(4 - mod) : normalized;
  return Buffer.from(padded, 'base64');
}
function buildError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function createPlaybackTokenService(config = {}) {
  const secret = String(config.secret || '').trim();
  if (!secret) {
    throw new Error('PLAYBACK_TOKEN_SECRET is required');
  }
  const ttlSec = parsePositiveInteger(config.ttlSec, 60);
  const maxUses = parsePositiveInteger(config.maxUses, 256);
  const ttlMs = ttlSec * 1000;
  const records = new Map();
  function cleanup(now = Date.now()) {
    for (const [nonce, record] of records.entries()) {
      if (!record || !Number.isFinite(record.expiresAt) || now >= record.expiresAt) {
        records.delete(nonce);
      }
    }
  }
  function sign(encodedPayload) {
    return toBase64Url(crypto.createHmac('sha256', secret).update(encodedPayload).digest());
  }
  function issue(payload = {}) {
    const now = Date.now();
    cleanup(now);
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = now + ttlMs;
    const encodedPayload = toBase64Url(JSON.stringify({
      nonce,
      exp: expiresAt
    }));
    const signature = sign(encodedPayload);
    const token = `${encodedPayload}.${signature}`;
    records.set(nonce, {
      ...payload,
      expiresAt,
      uses: 0,
      maxUses
    });
    return {
      token,
      expiresAt,
      ttlSec
    };
  }
  function consume(token) {
    const raw = String(token || '').trim();
    if (!raw) {
      throw buildError('Missing playback token', 401);
    }
    const separatorIndex = raw.lastIndexOf('.');
    if (separatorIndex <= 0 || separatorIndex >= raw.length - 1) {
      throw buildError('Invalid playback token', 401);
    }
    const encodedPayload = raw.slice(0, separatorIndex);
    const receivedSignature = raw.slice(separatorIndex + 1);
    const expectedSignature = sign(encodedPayload);
    if (!safeEqual(receivedSignature, expectedSignature)) {
      throw buildError('Invalid playback token signature', 401);
    }
    let payload = null;
    try {
      payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8'));
    } catch {
      throw buildError('Invalid playback token payload', 401);
    }
    const nonce = payload && payload.nonce ? String(payload.nonce) : '';
    const exp = payload && Number.isFinite(Number(payload.exp)) ? Number.parseInt(String(payload.exp), 10) : 0;
    if (!nonce || !Number.isFinite(exp) || exp <= 0) {
      throw buildError('Invalid playback token data', 401);
    }
    const now = Date.now();
    if (now >= exp) {
      records.delete(nonce);
      throw buildError('Playback token expired', 410);
    }
    cleanup(now);
    const record = records.get(nonce);
    if (!record) {
      throw buildError('Playback token is not available', 410);
    }
    if (!Number.isFinite(record.expiresAt) || now >= record.expiresAt) {
      records.delete(nonce);
      throw buildError('Playback token expired', 410);
    }
    if (record.maxUses > 0 && record.uses >= record.maxUses) {
      records.delete(nonce);
      throw buildError('Playback token was already used', 410);
    }
    record.uses += 1;
    if (record.maxUses > 0 && record.uses >= record.maxUses) {
      records.delete(nonce);
    } else {
      records.set(nonce, record);
    }
    return {
      ...record
    };
  }
  return {
    issue,
    consume
  };
}

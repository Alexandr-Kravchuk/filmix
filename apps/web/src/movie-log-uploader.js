const FLUSH_INTERVAL_MS = 1500;
const MAX_PENDING = 200;
const URGENT_STAGE_PATTERN = /(error|failed|crash|unhandled|blocked|stalled|out_of_range)/i;

function generateSessionId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `sess-${Date.now().toString(36)}-${random}`;
}

export function createMovieLogUploader(options = {}) {
  const sessionId = String(options.sessionId || generateSessionId());
  const getApiBaseUrl = typeof options.getApiBaseUrl === 'function' ? options.getApiBaseUrl : () => '';
  const flushIntervalMs = Number.isFinite(Number(options.flushIntervalMs)) && Number(options.flushIntervalMs) > 0
    ? Number(options.flushIntervalMs)
    : FLUSH_INTERVAL_MS;
  const maxPending = Number.isFinite(Number(options.maxPending)) && Number(options.maxPending) > 0
    ? Math.floor(Number(options.maxPending))
    : MAX_PENDING;
  const pending = [];
  let timer = null;
  let unloadAttached = false;

  function buildEndpoint() {
    const base = getApiBaseUrl().replace(/\/$/, '');
    return `${base}/api/movie-log`;
  }
  function attachUnloadOnce() {
    if (unloadAttached) {
      return;
    }
    if (typeof globalThis.addEventListener !== 'function') {
      return;
    }
    unloadAttached = true;
    const flushOnUnload = () => {
      flushImmediate(true);
    };
    globalThis.addEventListener('pagehide', flushOnUnload);
    globalThis.addEventListener('beforeunload', flushOnUnload);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          flushImmediate(true);
        }
      });
    }
  }
  function schedule() {
    if (timer) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flushImmediate(false);
    }, flushIntervalMs);
  }
  function takeBatch() {
    if (!pending.length) {
      return [];
    }
    return pending.splice(0, pending.length);
  }
  function flushImmediate(useBeacon = false) {
    const batch = takeBatch();
    if (!batch.length) {
      return;
    }
    const body = JSON.stringify({ sessionId, entries: batch });
    const endpoint = buildEndpoint();
    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        const sent = navigator.sendBeacon(endpoint, blob);
        if (sent) {
          return;
        }
      } catch {
      }
    }
    if (typeof fetch !== 'function') {
      return;
    }
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {
      const restored = batch.slice(-Math.min(batch.length, maxPending));
      pending.unshift(...restored);
    });
  }
  function append(entry) {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    attachUnloadOnce();
    const wrapped = {
      at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
      stage: String(entry.stage || 'unknown'),
      payload: extractPayload(entry)
    };
    pending.push(wrapped);
    while (pending.length > maxPending) {
      pending.shift();
    }
    if (URGENT_STAGE_PATTERN.test(wrapped.stage)) {
      flushImmediate(false);
      return;
    }
    schedule();
  }
  function extractPayload(entry) {
    const copy = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'at' || key === 'stage') {
        continue;
      }
      copy[key] = value;
    }
    return Object.keys(copy).length ? copy : null;
  }
  function flush() {
    flushImmediate(false);
  }

  return {
    sessionId,
    append,
    flush
  };
}

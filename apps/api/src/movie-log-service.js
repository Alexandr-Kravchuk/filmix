const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4000;
const DEFAULT_MAX_BATCH_SIZE = 100;

function clampString(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value);
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function sanitizePayload(value, maxBytes) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return clampString(JSON.stringify(value), maxBytes);
  }
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return clampString(text, maxBytes);
}

export function createMovieLogService(config = {}) {
  const maxEntries = Number.isFinite(Number(config.maxEntries)) && Number(config.maxEntries) > 0
    ? Math.floor(Number(config.maxEntries))
    : DEFAULT_MAX_ENTRIES;
  const maxPayloadBytes = Number.isFinite(Number(config.maxPayloadBytes)) && Number(config.maxPayloadBytes) > 0
    ? Math.floor(Number(config.maxPayloadBytes))
    : DEFAULT_MAX_PAYLOAD_BYTES;
  const maxBatchSize = Number.isFinite(Number(config.maxBatchSize)) && Number(config.maxBatchSize) > 0
    ? Math.floor(Number(config.maxBatchSize))
    : DEFAULT_MAX_BATCH_SIZE;
  const entries = [];
  let nextId = 1;

  function append(items, context = {}) {
    const list = Array.isArray(items) ? items.slice(0, maxBatchSize) : [];
    const sessionId = clampString(context.sessionId || '', 64);
    const sourceIp = clampString(context.sourceIp || '', 64);
    const sourceUserAgent = clampString(context.sourceUserAgent || '', 200);
    const receivedAt = Date.now();
    const sanitized = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const stage = clampString(item.stage || 'unknown', 80);
      const at = clampString(item.at || new Date(receivedAt).toISOString(), 40);
      const payload = sanitizePayload(item.payload !== undefined ? item.payload : item.details || item.data || null, maxPayloadBytes);
      const entry = {
        id: nextId++,
        sessionId,
        sourceIp,
        sourceUserAgent,
        receivedAt,
        at,
        stage,
        payload
      };
      entries.push(entry);
      sanitized.push(entry);
    }
    while (entries.length > maxEntries) {
      entries.shift();
    }
    return sanitized.length;
  }

  function list(options = {}) {
    const session = clampString(options.session || '', 64);
    const since = Number.parseInt(String(options.since || ''), 10);
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.min(Math.floor(Number(options.limit)), maxEntries)
      : maxEntries;
    let result = entries;
    if (session) {
      result = result.filter((entry) => entry.sessionId === session);
    }
    if (Number.isFinite(since) && since > 0) {
      result = result.filter((entry) => entry.id > since);
    }
    if (result.length > limit) {
      result = result.slice(result.length - limit);
    }
    return result.map((entry) => ({ ...entry }));
  }

  function listSessions() {
    const map = new Map();
    for (const entry of entries) {
      const key = entry.sessionId || '(empty)';
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          sessionId: entry.sessionId,
          firstReceivedAt: entry.receivedAt,
          lastReceivedAt: entry.receivedAt,
          entries: 1,
          sourceUserAgent: entry.sourceUserAgent
        });
        continue;
      }
      existing.entries += 1;
      existing.lastReceivedAt = entry.receivedAt;
      if (entry.sourceUserAgent && !existing.sourceUserAgent) {
        existing.sourceUserAgent = entry.sourceUserAgent;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.lastReceivedAt - a.lastReceivedAt);
  }

  function clear() {
    entries.length = 0;
    nextId = 1;
  }

  return {
    append,
    list,
    listSessions,
    clear,
    get size() {
      return entries.length;
    }
  };
}

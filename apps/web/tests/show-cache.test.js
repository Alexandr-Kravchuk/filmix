import test from 'node:test';
import assert from 'node:assert/strict';
import { readShowCache, writeShowCache, clearShowCache } from '../src/show-cache.js';

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test('reads valid show cache within ttl', () => {
  const storage = createStorage();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  const now = Date.now();
  const payload = {
    title: 'PAW Patrol',
    seasons: [1],
    episodesBySeason: { '1': [1] },
    fixed: { season: 1, episode: 1 }
  };
  try {
    writeShowCache(payload, now);
    const cached = readShowCache(now + 1000);
    assert.deepEqual(cached, payload);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('drops expired cache', () => {
  const payload = {
    title: 'PAW Patrol',
    seasons: [1],
    episodesBySeason: { '1': [1] },
    fixed: { season: 1, episode: 1 }
  };
  const record = {
    version: 1,
    savedAt: 1000,
    payload
  };
  const storage = createStorage({ 'filmix-show-cache-v1': JSON.stringify(record) });
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const cached = readShowCache(1000 + TTL_MS + 1);
    assert.equal(cached, null);
    assert.equal(storage.getItem('filmix-show-cache-v1'), null);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('drops broken cache json', () => {
  const storage = createStorage({ 'filmix-show-cache-v1': '{broken-json' });
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const cached = readShowCache(Date.now());
    assert.equal(cached, null);
    assert.equal(storage.getItem('filmix-show-cache-v1'), null);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('clears cache key', () => {
  const storage = createStorage({ 'filmix-show-cache-v1': JSON.stringify({}) });
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    clearShowCache();
    assert.equal(storage.getItem('filmix-show-cache-v1'), null);
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

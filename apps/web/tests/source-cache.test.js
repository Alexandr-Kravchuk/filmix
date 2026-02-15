import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSourceCacheKey, readSourceUrl, writeSourceUrl, writeSourceUrls } from '../src/source-cache.js';

const TTL_MS = 24 * 60 * 60 * 1000;

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

test('writes and reads source url by episode key', () => {
  const storage = createStorage();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    writeSourceUrl('5:11', 'https://cdn.example/s05e11_1080.mp4', 1000);
    const cached = readSourceUrl('5:11', 1001);
    assert.equal(cached, 'https://cdn.example/s05e11_1080.mp4');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('returns empty string for expired source url', () => {
  const storage = createStorage({
    'filmix-source-cache-v1': JSON.stringify({
      version: 1,
      items: {
        '5:11': {
          sourceUrl: 'https://cdn.example/s05e11_1080.mp4',
          savedAt: 1000
        }
      }
    })
  });
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    const cached = readSourceUrl('5:11', 1000 + TTL_MS + 1);
    assert.equal(cached, '');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('stores multiple source urls from batch payload', () => {
  const storage = createStorage();
  const originalStorage = globalThis.localStorage;
  globalThis.localStorage = storage;
  try {
    writeSourceUrls([
      { episodeKey: '5:11', sourceUrl: 'https://cdn.example/s05e11_1080.mp4' },
      { episodeKey: '5:12', sourceUrl: 'https://cdn.example/s05e12_1080.mp4' }
    ], 5000);
    assert.equal(readSourceUrl('5:11', 5001), 'https://cdn.example/s05e11_1080.mp4');
    assert.equal(readSourceUrl('5:12', 5001), 'https://cdn.example/s05e12_1080.mp4');
  } finally {
    globalThis.localStorage = originalStorage;
  }
});

test('builds source cache key with quality', () => {
  assert.equal(buildSourceCacheKey(5, 11, 480), '5:11:480');
  assert.equal(buildSourceCacheKey(5, 11, 'max'), '5:11:max');
  assert.equal(buildSourceCacheKey(5, 11), '5:11:max');
});

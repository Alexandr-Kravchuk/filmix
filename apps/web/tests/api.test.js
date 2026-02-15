import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShow, fetchSourceByEpisode, getApiBaseUrl } from '../src/api.js';

test('uses localhost api base by default', () => {
  assert.equal(getApiBaseUrl(), 'http://localhost:3000');
});

test('exports show loader', () => {
  assert.equal(typeof fetchShow, 'function');
});
test('exports episode source loader', () => {
  assert.equal(typeof fetchSourceByEpisode, 'function');
});

test('sends force query when loading show with force option', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return {
      ok: true,
      async json() {
        return {};
      }
    };
  };
  try {
    await fetchShow({ force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/show\?force=1$/);
});

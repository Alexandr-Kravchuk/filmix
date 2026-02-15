import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShow, fetchSourceByEpisode, fetchSourceBatch, fetchSourceLadder, fetchPlaybackProgress, savePlaybackProgress, sendPlaybackProgressBeacon, getApiBaseUrl } from '../src/api.js';

test('uses localhost api base by default', () => {
  assert.equal(getApiBaseUrl(), 'http://localhost:3000');
});

test('exports show loader', () => {
  assert.equal(typeof fetchShow, 'function');
});
test('exports episode source loader', () => {
  assert.equal(typeof fetchSourceByEpisode, 'function');
});
test('exports source batch loader', () => {
  assert.equal(typeof fetchSourceBatch, 'function');
});
test('exports source ladder loader', () => {
  assert.equal(typeof fetchSourceLadder, 'function');
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

test('loads playback progress from api endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return {
      ok: true,
      async json() {
        return { season: 5, episode: 11, currentTime: 12 };
      }
    };
  };
  try {
    const payload = await fetchPlaybackProgress();
    assert.equal(payload.season, 5);
    assert.equal(payload.episode, 11);
    assert.equal(payload.currentTime, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/progress$/);
});

test('loads source batch with season and episodes csv', async () => {
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
    await fetchSourceBatch(5, [11, 12, 12, '13'], 480);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/source-batch\?season=5&episodes=11%2C12%2C13&quality=480$/);
});

test('loads source by episode with quality', async () => {
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
    await fetchSourceByEpisode(5, 11, 'max');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/source\?season=5&episode=11&quality=max$/);
});

test('loads source ladder for episode', async () => {
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
    await fetchSourceLadder(5, 11);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/source-ladder\?season=5&episode=11$/);
});

test('saves playback progress with json payload', async () => {
  const originalFetch = globalThis.fetch;
  let calledUrl = '';
  let calledInit = null;
  globalThis.fetch = async (url, init) => {
    calledUrl = String(url);
    calledInit = init;
    return {
      ok: true,
      async json() {
        return { ok: true };
      }
    };
  };
  const payload = { season: 5, episode: 11, currentTime: 120, duration: 1000, updatedAt: 1 };
  try {
    await savePlaybackProgress(payload, { keepalive: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calledUrl, /\/api\/progress$/);
  assert.equal(calledInit.method, 'POST');
  assert.equal(calledInit.keepalive, true);
  assert.equal(calledInit.headers['Content-Type'], 'application/json');
  assert.equal(calledInit.body, JSON.stringify(payload));
});

test('returns false when beacon api is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {}
  });
  try {
    assert.equal(sendPlaybackProgressBeacon({ season: 5 }), false);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'navigator', descriptor);
    } else {
      delete globalThis.navigator;
    }
  }
});

test('sends progress beacon as plain text json string', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let urlValue = '';
  let dataValue = '';
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      sendBeacon(url, data) {
        urlValue = String(url);
        dataValue = String(data);
        return true;
      }
    }
  });
  try {
    const result = sendPlaybackProgressBeacon({ season: 5, episode: 11, currentTime: 5 });
    assert.equal(result, true);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, 'navigator', descriptor);
    } else {
      delete globalThis.navigator;
    }
  }
  assert.match(urlValue, /\/api\/progress$/);
  assert.equal(dataValue, '{"season":5,"episode":11,"currentTime":5}');
});

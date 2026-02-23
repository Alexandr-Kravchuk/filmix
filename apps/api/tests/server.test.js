import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import request from 'supertest';
import { createApp } from '../src/server.js';

const decodeConfig = Object.freeze({
  file3Separator: ':<:',
  bk0: '2owKDUoGzsuLNEyhNx',
  bk1: '19n1iKBr89ubskS5zT',
  bk2: 'IDaBt08C9Wf7lYr0eH',
  bk3: 'lNjI9V5U1gMnsxt4Qr',
  bk4: 'o9wPt0ii42GWeS7L7A'
});

function encodeUtf8ToBase64(value) {
  const normalized = encodeURIComponent(String(value || '')).replace(/%([0-9A-F]{2})/g, (match, code) =>
    String.fromCharCode(Number.parseInt(code, 16))
  );
  return Buffer.from(normalized, 'binary').toString('base64');
}
function encodePlayerjsValue(value) {
  const normalized = encodeURIComponent(String(value || '')).replace(/%([0-9A-F]{2})/g, (match, code) =>
    String.fromCharCode(Number.parseInt(code, 16))
  );
  const base = Buffer.from(normalized, 'binary').toString('base64');
  const markers = [decodeConfig.bk4, decodeConfig.bk3, decodeConfig.bk2, decodeConfig.bk1, decodeConfig.bk0]
    .map((key) => `${decodeConfig.file3Separator}${encodeUtf8ToBase64(key)}`)
    .join('');
  return `#2${base}${markers}`;
}

const playerDataFixture = {
  message: {
    links: [
      {
        name: 'Дубляж [ru, SDI Media]',
        files: {
          'Сезон 1': {
            'Серия 1': [{ quality: '1080', url: 'https://cdn.example/ru/s01e01_1080.mp4' }],
            'Серия 2': [{ quality: '720', url: 'https://cdn.example/ru/s01e02_720.mp4' }]
          }
        }
      },
      {
        name: 'Дубляж [Ukr, MEGOGO Voice]',
        files: {
          'Сезон 1': {
            'Серия 1': [{ quality: '720', url: 'https://cdn.example/uk/s01e01_720.mp4' }]
          }
        }
      }
    ]
  }
};

function createTestApp(overrides = {}) {
  return createApp({
    corsOrigin: 'http://localhost:5173,https://example.github.io',
    showTitle: 'PAW Patrol',
    fixedSeason: 1,
    fixedEpisode: 1,
    playbackTokenSecret: 'test-secret',
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    },
    ...overrides
  });
}

test('source and episode endpoints return tokenized payload without raw source urls', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-secure-'));
  const mapPath = path.join(tempDir, 'english-map.json');
  await fs.writeFile(mapPath, `${JSON.stringify({ '1:1': 'https://cdn.example/en/s01e01.m3u8' }, null, 2)}\n`, 'utf8');
  const app = createTestApp({
    mapPath
  });
  const sourceResponse = await request(app).get('/api/source').query({ season: 1, episode: 1 }).expect(200);
  assert.equal(typeof sourceResponse.body.playbackToken, 'string');
  assert.match(sourceResponse.body.playbackUrl, /^\/api\/stream\//);
  assert.equal(Object.hasOwn(sourceResponse.body, 'sourceUrl'), false);
  assert.equal(Number.isFinite(Number(sourceResponse.body.expiresAt)), true);
  const episodeResponse = await request(app).get('/api/episode').query({ season: 1, episode: 1 }).expect(200);
  assert.equal(Array.isArray(episodeResponse.body.sources), true);
  assert.equal(episodeResponse.body.sources.every((item) => !Object.hasOwn(item, 'sourceUrl')), true);
  const playResponse = await request(app).get('/api/play').query({ season: 1, episode: 1, lang: 'en' }).expect(302);
  assert.match(String(playResponse.headers.location || ''), /^\/api\/stream\//);
});

test('fixed episode playback token streams local media and respects max token uses', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-stream-'));
  const fixedFilePath = path.join(tempDir, 'fixed.mp4');
  await fs.writeFile(fixedFilePath, Buffer.from('0123456789', 'utf8'));
  const app = createTestApp({
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedLocalFilePath: fixedFilePath,
    playbackTokenMaxUses: 2
  });
  const fixedEpisode = await request(app).get('/api/fixed-episode').expect(200);
  assert.match(String(fixedEpisode.body.playUrl || ''), /^\/api\/stream\//);
  assert.equal(Object.hasOwn(fixedEpisode.body, 'sourceUrl'), false);
  await request(app).get(fixedEpisode.body.playUrl).set('Range', 'bytes=0-1').expect(206);
  await request(app).get(fixedEpisode.body.playUrl).set('Range', 'bytes=2-3').expect(206);
  await request(app).get(fixedEpisode.body.playUrl).set('Range', 'bytes=4-5').expect(410);
});

test('creates playback token via dedicated endpoint and validates request body', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-token-'));
  const fixedFilePath = path.join(tempDir, 'fixed.mp4');
  await fs.writeFile(fixedFilePath, Buffer.from('abcdefghij', 'utf8'));
  const app = createTestApp({
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedLocalFilePath: fixedFilePath
  });
  await request(app).post('/api/playback-token').send({ season: 5 }).expect(400);
  const tokenResponse = await request(app)
    .post('/api/playback-token')
    .send({ season: 5, episode: 11, quality: 480 })
    .expect(200);
  assert.match(String(tokenResponse.body.playbackUrl || ''), /^\/api\/stream\//);
  await request(app).get(tokenResponse.body.playbackUrl).set('Range', 'bytes=0-1').expect(206);
});

test('returns tokenized ladder and batch payloads', async () => {
  const playlistUrl = 'https://filmix.zip/pl/paw.batch.txt';
  const encodedPlaylist = encodePlayerjsValue(
    JSON.stringify([
      {
        title: 'Сезон 5',
        folder: [
          {
            id: 's5e11',
            file: '[480p]https://cdn.example/paw/s05e11_480.mp4,[1080p]https://cdn.example/paw/s05e11_1080.mp4'
          },
          {
            id: 's5e12',
            file: '[480p]https://cdn.example/paw/s05e12_480.mp4,[1080p]https://cdn.example/paw/s05e12_1080.mp4'
          }
        ]
      }
    ])
  );
  const app = createTestApp({
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedQuality: 1080,
    playlistFetch: async (url) => {
      assert.equal(url, playlistUrl);
      return {
        ok: true,
        status: 200,
        async text() {
          return encodedPlaylist;
        }
      };
    },
    filmixClient: {
      async getPlayerData() {
        return {
          message: {
            translations: {
              video: {
                'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(playlistUrl)
              }
            },
            links: []
          }
        };
      }
    }
  });
  const ladder = await request(app).get('/api/source-ladder').query({ season: 5, episode: 11 }).expect(200);
  assert.equal(Array.isArray(ladder.body.sources), true);
  assert.equal(ladder.body.sources.every((item) => typeof item.playbackUrl === 'string'), true);
  assert.equal(ladder.body.sources.every((item) => !Object.hasOwn(item, 'sourceUrl')), true);
  const sourceMin = await request(app).get('/api/source').query({ season: 5, episode: 11, quality: 'min' }).expect(200);
  assert.equal(typeof sourceMin.body.playbackUrl, 'string');
  assert.equal(sourceMin.body.quality, 480);
  const sourceLow = await request(app).get('/api/source').query({ season: 5, episode: 11, quality: 'low' }).expect(200);
  assert.equal(typeof sourceLow.body.playbackUrl, 'string');
  assert.equal(sourceLow.body.quality, 480);
  const batch = await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12,99' }).expect(200);
  assert.deepEqual(batch.body.items.map((item) => item.episode), [11, 12]);
  assert.equal(batch.body.items.every((item) => typeof item.playbackUrl === 'string'), true);
  await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12', quality: 'bad' }).expect(400);
});

test('uses strict validation for season and episode', async () => {
  const app = createTestApp();
  await request(app).get('/api/source').query({ season: '1.5', episode: 1 }).expect(400);
  await request(app).get('/api/source').query({ season: '01', episode: 1 }).expect(400);
  await request(app).get('/api/source').query({ season: 1, episode: 0 }).expect(400);
  await request(app).get('/api/source').query({ season: 1 }).expect(400);
  await request(app).get('/api/episode').query({ season: 1, episode: '1.2' }).expect(400);
  await request(app).get('/api/source-ladder').query({ season: 1, episode: '1.2' }).expect(400);
  await request(app).get('/api/play').query({ season: 1, episode: '1.2' }).expect(400);
});

test('hides version in health response by default', async () => {
  const appDefault = createTestApp();
  const healthDefault = await request(appDefault).get('/api/health').expect(200);
  assert.equal(healthDefault.body.ok, true);
  assert.equal(Object.hasOwn(healthDefault.body, 'version'), false);
  const appWithVersion = createTestApp({
    exposeHealthVersion: true,
    version: 'abc123'
  });
  const healthWithVersion = await request(appWithVersion).get('/api/health').expect(200);
  assert.equal(healthWithVersion.body.version, 'abc123');
});

test('enforces CORS origin restrictions when localhost is disabled', async () => {
  const app = createTestApp({
    allowLocalhostOrigins: false,
    corsOrigin: 'https://allowed.example'
  });
  await request(app).get('/api/health').set('Origin', 'https://blocked.example').expect(403);
  const allowed = await request(app).get('/api/health').set('Origin', 'https://allowed.example').expect(200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://allowed.example');
});

test('applies rate limiting to sensitive endpoints', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-rate-limit-'));
  const mapPath = path.join(tempDir, 'english-map.json');
  await fs.writeFile(mapPath, `${JSON.stringify({ '1:1': 'https://cdn.example/en/s01e01.m3u8' }, null, 2)}\n`, 'utf8');
  const app = createTestApp({
    mapPath,
    rateLimitWindowMs: 60000,
    rateLimitMaxRequests: 1
  });
  await request(app).get('/api/source').query({ season: 1, episode: 1 }).expect(200);
  await request(app).get('/api/source').query({ season: 1, episode: 1 }).expect(429);
});

test('imports har entries with admin token and keeps episode output sanitized', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-admin-'));
  const mapPath = path.join(tempDir, 'english-map.json');
  await fs.writeFile(mapPath, `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  const app = createTestApp({
    mapPath,
    adminToken: 'secret-token'
  });
  await request(app)
    .post('/api/admin/import-har')
    .send({ log: { entries: [] } })
    .expect(401);
  const importPayload = {
    log: {
      entries: [
        {
          request: {
            url: 'https://cdn.example/en/s01e02_720.m3u8?audio=english',
            headers: [],
            postData: { text: '' }
          },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
            content: { mimeType: 'application/vnd.apple.mpegurl', text: '#EXTM3U' }
          }
        }
      ]
    }
  };
  await request(app)
    .post('/api/admin/import-har')
    .set('Authorization', 'Bearer secret-token')
    .send(importPayload)
    .expect(200);
  const episode = await request(app).get('/api/episode').query({ season: 1, episode: 2 }).expect(200);
  assert.equal(episode.body.sources.some((item) => item.lang === 'en'), true);
  assert.equal(episode.body.sources.every((item) => !Object.hasOwn(item, 'sourceUrl')), true);
});

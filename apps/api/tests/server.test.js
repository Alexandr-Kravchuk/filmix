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
test('resolves season 12 episode 1 by falling back from ukrainian to another translation playlist', async () => {
  const ukrainianPlaylistUrl = 'https://filmix.zip/pl/paw.ukr.txt';
  const russianPlaylistUrl = 'https://filmix.zip/pl/paw.ru.txt';
  const ukrainianPlaylist = encodePlayerjsValue(
    JSON.stringify([
      {
        title: 'Сезон 11',
        folder: [
          {
            id: 's11e01',
            file: '[480p]https://cdn.example/paw/s11e01_480.mp4'
          }
        ]
      }
    ])
  );
  const russianPlaylist = encodePlayerjsValue(
    JSON.stringify([
      {
        title: 'Сезон 12',
        folder: [
          {
            id: 's12e01',
            file: '[720p]https://cdn.example/paw/s12e01_720.mp4,[1080p]https://cdn.example/paw/s12e01_1080.mp4'
          }
        ]
      }
    ])
  );
  const app = createTestApp({
    fixedSeason: 12,
    fixedEpisode: 1,
    fixedQuality: 1080,
    playlistFetch: async (url) => {
      if (url === ukrainianPlaylistUrl) {
        return {
          ok: true,
          status: 200,
          async text() {
            return ukrainianPlaylist;
          }
        };
      }
      if (url === russianPlaylistUrl) {
        return {
          ok: true,
          status: 200,
          async text() {
            return russianPlaylist;
          }
        };
      }
      throw new Error(`Unexpected playlist url ${url}`);
    },
    filmixClient: {
      async getPlayerData() {
        return {
          message: {
            translations: {
              video: {
                'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(ukrainianPlaylistUrl),
                'Дубляж [ru, SDI Media]': encodePlayerjsValue(russianPlaylistUrl)
              }
            },
            links: []
          }
        };
      }
    }
  });
  const sourceResponse = await request(app).get('/api/source').query({ season: 12, episode: 1 }).expect(200);
  assert.equal(sourceResponse.body.quality, 1080);
  assert.equal(typeof sourceResponse.body.playbackUrl, 'string');
  const ladderResponse = await request(app).get('/api/source-ladder').query({ season: 12, episode: 1 }).expect(200);
  assert.equal(ladderResponse.body.maxQuality, 1080);
  assert.equal(ladderResponse.body.sources.length, 2);
});

test('movie endpoint returns ordered candidates with ukrainian translation as primary', async () => {
  const moviePlayerData = {
    message: {
      title: 'PAW Patrol Christmas',
      translations: {
        video: {
          'MVO [1080, заКАДРЫ]': encodePlayerjsValue('[480p]https://cdn.example/movie/mvo_480.mp4,[1080p]https://cdn.example/movie/mvo_1080.mp4'),
          'Дубляж [1080, Ukr, 1+1]': encodePlayerjsValue('[480p]https://cdn.example/movie/ukr_480.mp4,[1080p]https://cdn.example/movie/ukr_1080.mp4'),
          'Дубляж [1080, Blackbird Sound]': encodePlayerjsValue('[1080p]https://cdn.example/movie/blackbird_1080.mp4')
        }
      },
      links: []
    }
  };
  const app = createTestApp({
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      },
      async getPlayerDataForUrl() {
        return moviePlayerData;
      }
    }
  });
  const response = await request(app)
    .get('/api/movie')
    .query({ url: 'https://filmix.zip/mults/semejnye/181452-foo.html' })
    .expect(200);
  assert.equal(Array.isArray(response.body.candidates), true);
  assert.equal(response.body.candidates.length, 3);
  assert.equal(response.body.candidates[0].translationName, 'Дубляж [1080, Ukr, 1+1]');
  assert.equal(response.body.translationName, 'Дубляж [1080, Ukr, 1+1]');
  assert.equal(response.body.candidates.every((item) => typeof item.playbackUrl === 'string'), true);
  assert.equal(response.body.candidates.every((item) => !Object.hasOwn(item, 'sourceUrl')), true);
});

test('movie endpoint returns tokenized playback for ukrainian translation with quality fallback', async () => {
  const moviePlayerData = {
    message: {
      title: 'PAW Patrol Christmas',
      translations: {
        video: {
          'MVO [1080, заКАДРЫ]': encodePlayerjsValue('[480p]https://cdn.example/movie/mvo_480.mp4,[1080p]https://cdn.example/movie/mvo_1080.mp4'),
          'Дубляж [1080, Ukr, 1+1]': encodePlayerjsValue('[480p]https://cdn.example/movie/ukr_480.mp4,[720p]https://cdn.example/movie/ukr_720.mp4,[1080p]https://cdn.example/movie/ukr_1080.mp4'),
          'Дубляж [1080, Blackbird Sound]': encodePlayerjsValue('[1080p]https://cdn.example/movie/blackbird_1080.mp4')
        }
      },
      links: []
    }
  };
  const calls = [];
  const app = createTestApp({
    filmixClient: {
      async getPlayerData() {
        throw new Error('series getPlayerData should not be called for movie endpoint');
      },
      async getPlayerDataForUrl(pageUrl) {
        calls.push(pageUrl);
        return moviePlayerData;
      }
    }
  });
  const movieMax = await request(app)
    .get('/api/movie')
    .query({ url: 'https://filmix.zip/mults/semejnye/181452-v-schenyachiy-patrul-rozhdestvo-2025.html' })
    .expect(200);
  assert.equal(calls[0], 'https://filmix.zip/mults/semejnye/181452-v-schenyachiy-patrul-rozhdestvo-2025.html');
  assert.equal(movieMax.body.title, 'PAW Patrol Christmas');
  assert.equal(movieMax.body.translationName, 'Дубляж [1080, Ukr, 1+1]');
  assert.equal(movieMax.body.quality, 1080);
  assert.match(String(movieMax.body.playbackUrl || ''), /^\/api\/stream\//);
  assert.equal(Object.hasOwn(movieMax.body, 'sourceUrl'), false);
  assert.deepEqual(movieMax.body.availableQualities, [480, 720, 1080]);
  const movie480 = await request(app)
    .get('/api/movie')
    .query({
      url: 'https://filmix.zip/mults/semejnye/181452-v-schenyachiy-patrul-rozhdestvo-2025.html',
      quality: '480'
    })
    .expect(200);
  assert.equal(movie480.body.quality, 480);
});

test('movie endpoint validates filmix url and quality', async () => {
  const app = createTestApp({
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      },
      async getPlayerDataForUrl() {
        throw new Error('should not be called for invalid url');
      }
    }
  });
  await request(app).get('/api/movie').expect(400);
  await request(app).get('/api/movie').query({ url: 'https://example.com/movie.html' }).expect(400);
  await request(app).get('/api/movie').query({ url: 'https://filmix.zip/about' }).expect(400);
  await request(app).get('/api/movie').query({
    url: 'https://filmix.zip/mults/semejnye/181452-v-schenyachiy-patrul-rozhdestvo-2025.html',
    quality: 'bad'
  }).expect(400);
});

test('movie endpoint returns 404 when no movie sources are available', async () => {
  const app = createTestApp({
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      },
      async getPlayerDataForUrl() {
        return {
          message: {
            translations: {
              video: {
                'Original [English]': encodePlayerjsValue('https://filmix.zip/pl/series.txt')
              }
            },
            links: []
          }
        };
      }
    }
  });
  await request(app)
    .get('/api/movie')
    .query({ url: 'https://filmix.zip/mults/semejnye/181452-v-schenyachiy-patrul-rozhdestvo-2025.html' })
    .expect(404);
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

test('movie log endpoint accepts json and text payload and lists entries', async () => {
  const app = createTestApp();
  await request(app)
    .post('/api/movie-log')
    .set('Content-Type', 'application/json')
    .send({
      sessionId: 'sess-json',
      entries: [
        { stage: 'flow:start', payload: { url: 'https://filmix.zip/x' } },
        { stage: 'download:start' }
      ]
    })
    .expect(200);
  await request(app)
    .post('/api/movie-log')
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({
      sessionId: 'sess-text',
      entries: [
        { stage: 'ffmpeg:segment_start', payload: { candidateIndex: 0 } }
      ]
    }))
    .expect(200);
  const all = await request(app).get('/api/movie-log').expect(200);
  assert.equal(all.body.entries.length, 3);
  assert.equal(all.body.total, 3);
  const filtered = await request(app).get('/api/movie-log').query({ session: 'sess-text' }).expect(200);
  assert.deepEqual(filtered.body.entries.map((entry) => entry.stage), ['ffmpeg:segment_start']);
  const sessions = await request(app).get('/api/movie-log').query({ format: 'sessions' }).expect(200);
  assert.equal(Array.isArray(sessions.body.sessions), true);
  assert.equal(sessions.body.sessions.length, 2);
});

test('movie log endpoint rejects malformed payload', async () => {
  const app = createTestApp();
  await request(app)
    .post('/api/movie-log')
    .set('Content-Type', 'text/plain')
    .send('not-json')
    .expect(400);
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

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

test('serves show, episode, play and har import', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-'));
  const mapPath = path.join(tempDir, 'english-map.json');
  await fs.writeFile(mapPath, `${JSON.stringify({ '1:1': 'https://cdn.example/en/s01e01.m3u8' }, null, 2)}\n`, 'utf8');
  const app = createApp({
    mapPath,
    adminToken: 'secret-token',
    corsOrigin: 'http://localhost:5173,https://example.github.io',
    showTitle: 'PAW Patrol',
    fixedSeason: 1,
    fixedEpisode: 1,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  const showResponse = await request(app).get('/api/show').expect(200);
  assert.equal(showResponse.body.title, 'PAW Patrol');
  assert.deepEqual(showResponse.body.seasons, [1]);
  assert.deepEqual(showResponse.body.episodesBySeason, { '1': [1, 2] });
  assert.deepEqual(showResponse.body.fixed, { season: 1, episode: 1 });
  assert.match(String(showResponse.headers['cache-control'] || ''), /max-age=30/);
  const episodeResponse = await request(app).get('/api/episode').query({ season: 1, episode: 1 }).expect(200);
  assert.equal(episodeResponse.body.defaultLang, 'en');
  assert.deepEqual(
    episodeResponse.body.sources.map((item) => item.lang),
    ['en', 'uk', 'ru']
  );
  const playResponse = await request(app).get('/api/play').query({ season: 1, episode: 1, lang: 'en' }).expect(302);
  assert.match(playResponse.headers.location, /^\/proxy\/video\?src=/);
  const fixedEpisodeResponse = await request(app).get('/api/fixed-episode').expect(200);
  assert.equal(fixedEpisodeResponse.body.season, 1);
  assert.equal(fixedEpisodeResponse.body.episode, 1);
  assert.match(fixedEpisodeResponse.body.playUrl, /^\/proxy\/video\?src=/);
  assert.equal(fixedEpisodeResponse.body.sourceUrl, 'https://cdn.example/en/s01e01.m3u8');
  const sourceResponse = await request(app).get('/api/source').expect(200);
  assert.equal(sourceResponse.body.sourceUrl, 'https://cdn.example/en/s01e01.m3u8');
  assert.equal(sourceResponse.body.origin, 'catalog');
  const sourceByEpisodeResponse = await request(app).get('/api/source').query({ season: 1, episode: 2 }).expect(200);
  assert.equal(sourceByEpisodeResponse.body.season, 1);
  assert.equal(sourceByEpisodeResponse.body.episode, 2);
  assert.equal(sourceByEpisodeResponse.body.sourceUrl, 'https://cdn.example/ru/s01e02_720.mp4');
  assert.equal(sourceByEpisodeResponse.body.origin, 'catalog');
  assert.equal(sourceByEpisodeResponse.body.quality, 720);
  assert.match(String(sourceByEpisodeResponse.headers['cache-control'] || ''), /max-age=30/);
  const sourceByQualityResponse = await request(app).get('/api/source').query({ season: 1, episode: 2, quality: 360 }).expect(200);
  assert.equal(sourceByQualityResponse.body.sourceUrl, 'https://cdn.example/ru/s01e02_720.mp4');
  assert.equal(sourceByQualityResponse.body.quality, 720);
  const sourceLadderResponse = await request(app).get('/api/source-ladder').query({ season: 1, episode: 2 }).expect(200);
  assert.equal(sourceLadderResponse.body.season, 1);
  assert.equal(sourceLadderResponse.body.episode, 2);
  assert.equal(sourceLadderResponse.body.bootstrapQuality, 480);
  assert.equal(sourceLadderResponse.body.maxQuality, 720);
  assert.deepEqual(
    sourceLadderResponse.body.sources.map((item) => item.quality),
    [720]
  );
  await request(app).get('/api/source').query({ season: 1, episode: 'x' }).expect(400);
  await request(app).get('/api/source').query({ season: 1, episode: 2, quality: 'bad' }).expect(400);
  await request(app).get('/api/source').query({ season: 1, episode: 9 }).expect(404);
  const fixedPlayResponse = await request(app).get('/api/play').expect(302);
  assert.match(fixedPlayResponse.headers.location, /^\/proxy\/video\?src=/);
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
  const episode2Response = await request(app).get('/api/episode').query({ season: 1, episode: 2 }).expect(200);
  assert.deepEqual(
    episode2Response.body.sources.map((item) => item.lang),
    ['en', 'ru']
  );
});

test('uses fixed public media url for one-episode mode', async () => {
  const mediaUrl = 'https://media.example.com/paw/s05e11_480_en.mp4';
  const appProxy = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedPublicMediaUrl: mediaUrl,
    fixedPublicMediaViaProxy: true,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  const proxyFixedEpisode = await request(appProxy).get('/api/fixed-episode').expect(200);
  assert.equal(proxyFixedEpisode.body.playUrl, `/proxy/video?src=${encodeURIComponent(mediaUrl)}`);
  assert.equal(proxyFixedEpisode.body.sourceUrl, mediaUrl);
  assert.equal(proxyFixedEpisode.body.origin, 'fixed-public');
  const proxySourceResponse = await request(appProxy).get('/api/source').expect(200);
  assert.equal(proxySourceResponse.body.sourceUrl, mediaUrl);
  assert.equal(proxySourceResponse.body.origin, 'fixed-public');
  const proxyPlay = await request(appProxy).get('/api/play').expect(302);
  assert.equal(proxyPlay.headers.location, `/proxy/video?src=${encodeURIComponent(mediaUrl)}`);
  const appDirect = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedPublicMediaUrl: mediaUrl,
    fixedPublicMediaViaProxy: false,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  const directFixedEpisode = await request(appDirect).get('/api/fixed-episode').expect(200);
  assert.equal(directFixedEpisode.body.playUrl, mediaUrl);
  assert.equal(directFixedEpisode.body.sourceUrl, mediaUrl);
  assert.equal(directFixedEpisode.body.origin, 'fixed-public');
  const directPlay = await request(appDirect).get('/api/play').expect(302);
  assert.equal(directPlay.headers.location, mediaUrl);
});

test('uses decoded filmix playlist for fixed episode when direct source is not configured', async () => {
  const playlistUrl = 'https://filmix.zip/pl/paw.txt';
  const encodedPlaylist = encodePlayerjsValue(
    JSON.stringify([
      {
        title: 'Сезон 5',
        folder: [
          {
            id: 's5e11',
            file: '[480p]https://cdn.example/paw/s05e11_480.mp4,[720p]https://cdn.example/paw/s05e11_720.mp4'
          }
        ]
      }
    ])
  );
  const app = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedQuality: 480,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
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
  const response = await request(app).get('/api/fixed-episode').expect(200);
  assert.equal(
    response.body.playUrl,
    `/proxy/video?src=${encodeURIComponent('https://cdn.example/paw/s05e11_480.mp4')}`
  );
  assert.equal(response.body.sourceUrl, 'https://cdn.example/paw/s05e11_480.mp4');
  assert.equal(response.body.origin, 'player-data');
  const sourceResponse = await request(app).get('/api/source').expect(200);
  assert.equal(sourceResponse.body.sourceUrl, 'https://cdn.example/paw/s05e11_480.mp4');
  assert.equal(sourceResponse.body.origin, 'player-data');
});
test('renders watch page for direct source url', async () => {
  const app = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  await request(app).get('/watch').expect(400);
  const src = 'https://cdn.example/video.mp4?user=1093269';
  const response = await request(app).get('/watch').query({ src }).expect(200);
  assert.match(response.headers['content-type'], /text\/html/);
  assert.match(response.text, /<video/);
  assert.match(response.text, new RegExp(encodeURIComponent(src)));
});

test('forces /api/show catalog rebuild when force query is enabled', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-force-show-'));
  const mapPath = path.join(tempDir, 'english-map.json');
  await fs.writeFile(mapPath, `${JSON.stringify({}, null, 2)}\n`, 'utf8');
  let calls = 0;
  const app = createApp({
    mapPath,
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        calls += 1;
        return playerDataFixture;
      }
    }
  });
  await request(app).get('/api/show').expect(200);
  await request(app).get('/api/show').expect(200);
  assert.equal(calls, 1);
  await request(app).get('/api/show').query({ force: 1 }).expect(200);
  assert.equal(calls, 2);
});

test('stores and returns playback progress across app instances', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filmix-api-test-progress-'));
  const progressPath = path.join(tempDir, 'playback-progress.json');
  const app = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    playbackProgressPath: progressPath,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  const empty = await request(app).get('/api/progress').expect(200);
  assert.equal(empty.body.season, null);
  assert.equal(empty.body.episode, null);
  assert.equal(empty.body.currentTime, 0);
  assert.equal(empty.body.duration, 0);
  assert.equal(empty.body.updatedAt, 0);
  await request(app)
    .post('/api/progress')
    .send({ season: 5, episode: 11, currentTime: 75.25, duration: 1391, updatedAt: 100 })
    .expect(200);
  const saved = await request(app).get('/api/progress').expect(200);
  assert.equal(saved.body.season, 5);
  assert.equal(saved.body.episode, 11);
  assert.equal(saved.body.currentTime, 75.25);
  assert.equal(saved.body.duration, 1391);
  assert.equal(saved.body.updatedAt, 100);
  const ignoredOlder = await request(app)
    .post('/api/progress')
    .send({ season: 5, episode: 10, currentTime: 10, duration: 100, updatedAt: 50 })
    .expect(200);
  assert.equal(ignoredOlder.body.season, 5);
  assert.equal(ignoredOlder.body.episode, 11);
  const fromPlainText = await request(app)
    .post('/api/progress')
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ season: 5, episode: 11, currentTime: 80.5, duration: 1391, updatedAt: 200 }))
    .expect(200);
  assert.equal(fromPlainText.body.currentTime, 80.5);
  assert.equal(fromPlainText.body.updatedAt, 200);
  const appReloaded = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    playbackProgressPath: progressPath,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    filmixClient: {
      async getPlayerData() {
        return playerDataFixture;
      }
    }
  });
  const persisted = await request(appReloaded).get('/api/progress').expect(200);
  assert.equal(persisted.body.season, 5);
  assert.equal(persisted.body.episode, 11);
  assert.equal(persisted.body.currentTime, 80.5);
  assert.equal(persisted.body.duration, 1391);
  assert.equal(persisted.body.updatedAt, 200);
  await request(appReloaded).post('/api/progress').send({ season: 'x', episode: 11, currentTime: 5 }).expect(400);
});

test('serves source batch and reuses source cache for repeated source lookups', async () => {
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
  let playerDataCalls = 0;
  let playlistCalls = 0;
  const app = createApp({
    corsOrigin: 'http://localhost:5173',
    showTitle: 'PAW Patrol',
    fixedSeason: 5,
    fixedEpisode: 11,
    fixedQuality: 1080,
    sourceCacheTtlMs: 1800000,
    playlistCacheTtlMs: 600000,
    playerDataCacheTtlMs: 60000,
    pageUrl: 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html',
    userAgent: 'TestAgent',
    version: 'test',
    playlistFetch: async (url) => {
      assert.equal(url, playlistUrl);
      playlistCalls += 1;
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
        playerDataCalls += 1;
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
  for (let index = 0; index < 10; index += 1) {
    const response = await request(app).get('/api/source').query({ season: 5, episode: 11 }).expect(200);
    assert.equal(response.body.sourceUrl, 'https://cdn.example/paw/s05e11_1080.mp4');
    assert.equal(response.body.origin, 'player-data');
    assert.equal(response.body.quality, 1080);
  }
  assert.ok(playerDataCalls <= 2);
  assert.ok(playlistCalls <= 2);
  const source480 = await request(app).get('/api/source').query({ season: 5, episode: 11, quality: 480 }).expect(200);
  assert.equal(source480.body.sourceUrl, 'https://cdn.example/paw/s05e11_480.mp4');
  assert.equal(source480.body.quality, 480);
  const source900 = await request(app).get('/api/source').query({ season: 5, episode: 11, quality: 900 }).expect(200);
  assert.equal(source900.body.sourceUrl, 'https://cdn.example/paw/s05e11_480.mp4');
  assert.equal(source900.body.quality, 480);
  const ladder = await request(app).get('/api/source-ladder').query({ season: 5, episode: 11 }).expect(200);
  assert.equal(ladder.body.maxQuality, 1080);
  assert.deepEqual(
    ladder.body.sources.map((item) => item.quality),
    [480, 1080]
  );
  const batch = await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12,99' }).expect(200);
  assert.equal(batch.body.season, 5);
  assert.ok(Number.isFinite(Number(batch.body.generatedAt)));
  assert.deepEqual(
    batch.body.items.map((item) => item.episode),
    [11, 12]
  );
  assert.deepEqual(
    batch.body.items.map((item) => item.sourceUrl),
    ['https://cdn.example/paw/s05e11_1080.mp4', 'https://cdn.example/paw/s05e12_1080.mp4']
  );
  assert.match(String(batch.headers['cache-control'] || ''), /max-age=30/);
  const batch480 = await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12', quality: 480 }).expect(200);
  assert.deepEqual(
    batch480.body.items.map((item) => item.sourceUrl),
    ['https://cdn.example/paw/s05e11_480.mp4', 'https://cdn.example/paw/s05e12_480.mp4']
  );
  assert.deepEqual(
    batch480.body.items.map((item) => item.quality),
    [480, 480]
  );
  await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12' }).expect(200);
  assert.ok(playerDataCalls <= 2);
  assert.ok(playlistCalls <= 2);
  await request(app).get('/api/source-batch').query({ season: 'x', episodes: '11,12' }).expect(400);
  await request(app).get('/api/source-batch').query({ season: 5, episodes: '11,12', quality: 'bad' }).expect(400);
  await request(app).get('/api/source-batch').query({ season: 5, episodes: '' }).expect(400);
});

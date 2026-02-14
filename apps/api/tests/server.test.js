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
});

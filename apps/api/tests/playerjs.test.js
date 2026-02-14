import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePlayerjsValue, resolveEpisodeSourceFromPlayerData } from '../src/playerjs-service.js';

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

test('decodes playerjs #2 values', () => {
  const encoded = encodePlayerjsValue('https://filmix.zip/pl/example.txt');
  const decoded = decodePlayerjsValue(encoded);
  assert.equal(decoded, 'https://filmix.zip/pl/example.txt');
});

test('keeps non-encoded values unchanged', () => {
  const value = 'https://example.com/video.mp4';
  assert.equal(decodePlayerjsValue(value), value);
});

test('resolves episode source from translations video and playlist', async () => {
  const playlistUrl = 'https://filmix.zip/pl/paw.txt';
  const playlist = [
    {
      title: 'Сезон 5',
      folder: [
        {
          id: 's5e11',
          file: '[480p]https://cdn.example/paw/s05e11_480.mp4,[720p]https://cdn.example/paw/s05e11_720.mp4'
        }
      ]
    }
  ];
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(playlistUrl)
        }
      }
    }
  };
  const response = await resolveEpisodeSourceFromPlayerData(playerData, {
    season: 5,
    episode: 11,
    preferredQuality: 480,
    fetchImpl: async (url) => {
      assert.equal(url, playlistUrl);
      return {
        ok: true,
        status: 200,
        async text() {
          return encodePlayerjsValue(JSON.stringify(playlist));
        }
      };
    }
  });
  assert.equal(response.sourceUrl, 'https://cdn.example/paw/s05e11_480.mp4');
  assert.equal(response.playlistUrl, playlistUrl);
  assert.equal(response.translationName, 'Дубляж [Ukr, MEGOGO Voice]');
});

test('falls back to max quality when preferred quality is missing', async () => {
  const playlistUrl = 'https://filmix.zip/pl/paw.txt';
  const playlist = [
    {
      title: 'Сезон 5',
      folder: [
        {
          id: 's5e11',
          file: '[720p]https://cdn.example/paw/s05e11_720.mp4,[1080p]https://cdn.example/paw/s05e11_1080.mp4'
        }
      ]
    }
  ];
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(playlistUrl)
        }
      }
    }
  };
  const response = await resolveEpisodeSourceFromPlayerData(playerData, {
    season: 5,
    episode: 11,
    preferredQuality: 480,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return encodePlayerjsValue(JSON.stringify(playlist));
      }
    })
  });
  assert.equal(response.sourceUrl, 'https://cdn.example/paw/s05e11_1080.mp4');
});

test('throws when episode is missing in decoded playlist', async () => {
  const playlistUrl = 'https://filmix.zip/pl/paw.txt';
  const playlist = [
    {
      title: 'Сезон 5',
      folder: [
        {
          id: 's5e10',
          file: '[480p]https://cdn.example/paw/s05e10_480.mp4'
        }
      ]
    }
  ];
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(playlistUrl)
        }
      }
    }
  };
  await assert.rejects(
    () =>
      resolveEpisodeSourceFromPlayerData(playerData, {
        season: 5,
        episode: 11,
        preferredQuality: 480,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async text() {
            return encodePlayerjsValue(JSON.stringify(playlist));
          }
        })
      }),
    /episode source was not found/
  );
});

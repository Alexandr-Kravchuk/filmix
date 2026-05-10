import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePlayerjsValue, findEpisodeVariants, pickTranslation, pickVariant, resolveEpisodeSourceFromPlayerData, resolveMovieSourceFromPlayerData, resolveMovieVariantsFromPlayerData, resolvePlaylistUrlsFromPlayerData } from '../src/playerjs-service.js';

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
          'Original [English]': encodePlayerjsValue(playlistUrl)
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
  assert.equal(response.translationName, 'Original [English]');
});

test('falls back to nearest lower or minimum quality when preferred quality is missing', async () => {
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
          'Original [English]': encodePlayerjsValue(playlistUrl)
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
  assert.equal(response.sourceUrl, 'https://cdn.example/paw/s05e11_720.mp4');
  assert.equal(response.quality, 720);
});

test('extracts and sorts episode variants', () => {
  const variants = findEpisodeVariants(
    [{
      title: 'Сезон 5',
      folder: [{
        id: 's5e11',
        file: '[1080p]https://cdn.example/paw/s05e11_1080.mp4,[480p]https://cdn.example/paw/s05e11_480.mp4,[720p]https://cdn.example/paw/s05e11_720.mp4'
      }]
    }],
    5,
    11
  );
  assert.deepEqual(
    variants.map((item) => item.quality),
    [480, 720, 1080]
  );
});

test('picks exact, then lower, then minimum quality', () => {
  const variants = [
    { quality: 480, url: 'v480' },
    { quality: 720, url: 'v720' },
    { quality: 1080, url: 'v1080' }
  ];
  assert.equal(pickVariant(variants, 720).url, 'v720');
  assert.equal(pickVariant(variants, 900).url, 'v720');
  assert.equal(pickVariant(variants, 360).url, 'v480');
  assert.equal(pickVariant(variants, 'max').url, 'v1080');
  assert.equal(pickVariant(variants, 'min').url, 'v480');
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
          'Original [English]': encodePlayerjsValue(playlistUrl)
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
test('falls back to another translation playlist when preferred translation misses episode', async () => {
  const ukrainianPlaylistUrl = 'https://filmix.zip/pl/paw.ukr.txt';
  const russianPlaylistUrl = 'https://filmix.zip/pl/paw.ru.txt';
  const ukrainianPlaylist = [
    {
      title: 'Сезон 11',
      folder: [
        {
          id: 's11e01',
          file: '[480p]https://cdn.example/paw/s11e01_480.mp4'
        }
      ]
    }
  ];
  const russianPlaylist = [
    {
      title: 'Сезон 12',
      folder: [
        {
          id: 's12e01',
          file: '[720p]https://cdn.example/paw/s12e01_720.mp4,[1080p]https://cdn.example/paw/s12e01_1080.mp4'
        }
      ]
    }
  ];
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue(ukrainianPlaylistUrl),
          'Дубляж [ru, SDI Media]': encodePlayerjsValue(russianPlaylistUrl)
        }
      }
    }
  };
  const response = await resolveEpisodeSourceFromPlayerData(playerData, {
    season: 12,
    episode: 1,
    preferredQuality: 1080,
    preferredTranslationPattern: 'ukr|укра',
    fetchImpl: async (url) => {
      if (url === ukrainianPlaylistUrl) {
        return {
          ok: true,
          status: 200,
          async text() {
            return encodePlayerjsValue(JSON.stringify(ukrainianPlaylist));
          }
        };
      }
      if (url === russianPlaylistUrl) {
        return {
          ok: true,
          status: 200,
          async text() {
            return encodePlayerjsValue(JSON.stringify(russianPlaylist));
          }
        };
      }
      throw new Error(`Unexpected url ${url}`);
    }
  });
  assert.equal(response.sourceUrl, 'https://cdn.example/paw/s12e01_1080.mp4');
  assert.equal(response.translationName, 'Дубляж [ru, SDI Media]');
  assert.equal(response.playlistUrl, russianPlaylistUrl);
});
test('returns ordered translation playlist candidates', () => {
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [ru, SDI Media]': encodePlayerjsValue('https://filmix.zip/pl/ru.txt'),
          'Original [English]': encodePlayerjsValue('https://filmix.zip/pl/en.txt'),
          'Дубляж [Ukr, MEGOGO Voice]': encodePlayerjsValue('https://filmix.zip/pl/ukr.txt')
        }
      }
    }
  };
  const ordered = resolvePlaylistUrlsFromPlayerData(playerData, {
    preferredTranslationPattern: 'ukr|укра'
  });
  assert.deepEqual(
    ordered.map((item) => item.translationName),
    ['Дубляж [Ukr, MEGOGO Voice]', 'Original [English]', 'Дубляж [ru, SDI Media]']
  );
});


test('resolves movie variants from translation with file variants payload', () => {
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [1080, Ukr, 1+1]': encodePlayerjsValue('[480p]https://cdn.example/movie/ukr_480.mp4,[720p]https://cdn.example/movie/ukr_720.mp4,[1080p]https://cdn.example/movie/ukr_1080.mp4'),
          'MVO [1080, заКАДРЫ]': encodePlayerjsValue('[480p]https://cdn.example/movie/mvo_480.mp4,[1080p]https://cdn.example/movie/mvo_1080.mp4')
        }
      }
    }
  };
  const info = resolveMovieVariantsFromPlayerData(playerData, {
    preferredTranslationPattern: 'ukr|укра'
  });
  assert.equal(info.translationName, 'Дубляж [1080, Ukr, 1+1]');
  assert.deepEqual(info.variants.map((variant) => variant.quality), [480, 720, 1080]);
});

test('selects ukrainian movie variant by max quality', () => {
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [1080, Ukr, 1+1]': encodePlayerjsValue('[480p]https://cdn.example/movie/ukr_480.mp4,[720p]https://cdn.example/movie/ukr_720.mp4,[1080p]https://cdn.example/movie/ukr_1080.mp4'),
          'MVO [1080, заКАДРЫ]': encodePlayerjsValue('[1080p]https://cdn.example/movie/mvo_1080.mp4')
        }
      }
    }
  };
  const selected = resolveMovieSourceFromPlayerData(playerData, {
    preferredTranslationPattern: 'ukr|укра'
  });
  assert.equal(selected.sourceUrl, 'https://cdn.example/movie/ukr_1080.mp4');
  assert.equal(selected.quality, 1080);
  assert.equal(selected.translationName, 'Дубляж [1080, Ukr, 1+1]');
});

test('falls back to lower quality when preferred quality is missing for movie', () => {
  const playerData = {
    message: {
      translations: {
        video: {
          'Дубляж [1080, Ukr, 1+1]': encodePlayerjsValue('[720p]https://cdn.example/movie/ukr_720.mp4,[1080p]https://cdn.example/movie/ukr_1080.mp4')
        }
      }
    }
  };
  const selected = resolveMovieSourceFromPlayerData(playerData, {
    preferredTranslationPattern: 'ukr|укра',
    preferredQuality: 480
  });
  assert.equal(selected.sourceUrl, 'https://cdn.example/movie/ukr_720.mp4');
  assert.equal(selected.quality, 720);
});

test('returns null for movie variants when only series playlist urls are present', () => {
  const playerData = {
    message: {
      translations: {
        video: {
          'Original [English]': encodePlayerjsValue('https://filmix.zip/pl/series.txt')
        }
      }
    }
  };
  const info = resolveMovieVariantsFromPlayerData(playerData, {
    preferredTranslationPattern: 'ukr|укра'
  });
  assert.equal(info, null);
});

test('prefers english translation and ignores ukrainian fallback', () => {
  const preferred = pickTranslation({
    'Дубляж [Ukr, MEGOGO Voice]': '#2abc',
    'Original [English]': '#2def'
  });
  assert.equal(preferred[0], 'Original [English]');
  const missingEnglish = pickTranslation({
    'Дубляж [Ukr, MEGOGO Voice]': '#2abc',
    'Дубляж [ru, SDI Media]': '#2def'
  });
  assert.equal(missingEnglish, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalog, getEpisodeData } from '../src/catalog-service.js';
import { buildEpisodeKey, detectLanguage, pickDefaultLanguage } from '../src/types.js';

const playerDataFixture = {
  message: {
    links: [
      {
        name: 'Дубляж [ru, SDI Media]',
        files: {
          'Сезон 1': {
            'Серия 1': [
              { quality: '480', url: 'https://cdn.example/ru/s01e01_480.mp4' },
              { quality: '1080', url: 'https://cdn.example/ru/s01e01_1080.mp4' }
            ],
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

test('detects language names', () => {
  assert.equal(detectLanguage('Дубляж [ru, SDI Media]'), 'ru');
  assert.equal(detectLanguage('Дубляж [Ukr, MEGOGO Voice]'), 'uk');
  assert.equal(detectLanguage('English Audio'), 'en');
});

test('picks default language by priority en > uk > ru', () => {
  assert.equal(pickDefaultLanguage({ ru: 'a', uk: 'b' }), 'uk');
  assert.equal(pickDefaultLanguage({ ru: 'a', en: 'c' }), 'en');
  assert.equal(pickDefaultLanguage({ ru: 'a' }), 'ru');
});

test('builds catalog and merges english map', () => {
  const catalog = createCatalog(playerDataFixture, {
    showTitle: 'PAW Patrol',
    englishMap: {
      '1:1': 'https://cdn.example/en/s01e01.m3u8',
      '1:2': 'https://cdn.example/en/s01e02.m3u8'
    }
  });
  assert.equal(catalog.title, 'PAW Patrol');
  assert.deepEqual(catalog.seasons, [1]);
  assert.deepEqual(catalog.episodesBySeason['1'], [1, 2]);
  assert.deepEqual(catalog.languagesAvailable, ['en', 'uk', 'ru']);
  const key = buildEpisodeKey(1, 1);
  assert.equal(catalog.sourceMap[key].ru, 'https://cdn.example/ru/s01e01_1080.mp4');
  assert.equal(catalog.sourceMap[key].uk, 'https://cdn.example/uk/s01e01_720.mp4');
  assert.equal(catalog.sourceMap[key].en, 'https://cdn.example/en/s01e01.m3u8');
});

test('returns episode data in language order', () => {
  const catalog = createCatalog(playerDataFixture, {
    englishMap: {
      '1:1': 'https://cdn.example/en/s01e01.m3u8'
    }
  });
  const data = getEpisodeData(catalog, 1, 1);
  assert.equal(data.defaultLang, 'en');
  assert.deepEqual(
    data.sources.map((item) => item.lang),
    ['en', 'uk', 'ru']
  );
});

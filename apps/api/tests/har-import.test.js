import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHarToEnglishMap } from '../src/har-import-service.js';

test('extracts english links by season and episode from har', () => {
  const harObject = {
    log: {
      entries: [
        {
          request: {
            url: 'https://cdn.example/show/s01e01_720.m3u8?audio=english',
            headers: [],
            postData: { text: '' }
          },
          response: {
            status: 200,
            headers: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
            content: { mimeType: 'application/vnd.apple.mpegurl', text: '#EXTM3U' }
          }
        },
        {
          request: {
            url: 'https://cdn.example/show/s01e01_480.mp4?lang=ru',
            headers: [],
            postData: { text: '' }
          },
          response: {
            status: 206,
            headers: [{ name: 'content-type', value: 'video/mp4' }],
            content: { mimeType: 'video/mp4', text: '' }
          }
        },
        {
          request: {
            url: 'https://cdn.example/show/s01e02_480.mp4?track=eng',
            headers: [],
            postData: { text: '' }
          },
          response: {
            status: 206,
            headers: [{ name: 'content-type', value: 'video/mp4' }],
            content: { mimeType: 'video/mp4', text: '' }
          }
        }
      ]
    }
  };
  const result = parseHarToEnglishMap(harObject, { existingMap: {} });
  assert.equal(result['1:1'], 'https://cdn.example/show/s01e01_720.m3u8?audio=english');
  assert.equal(result['1:2'], 'https://cdn.example/show/s01e02_480.mp4?track=eng');
});

test('keeps existing map when no better candidates', () => {
  const harObject = {
    log: {
      entries: []
    }
  };
  const result = parseHarToEnglishMap(harObject, {
    existingMap: {
      '2:5': 'https://existing.example/s02e05.m3u8'
    }
  });
  assert.equal(result['2:5'], 'https://existing.example/s02e05.m3u8');
});

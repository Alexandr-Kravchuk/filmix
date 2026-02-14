import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAudioStreamIndex } from '../src/ffmpeg-service.js';

test('picks english audio stream by language tag', () => {
  const index = pickAudioStreamIndex([
    { index: 0, codec_type: 'video', tags: { language: 'und' } },
    { index: 1, codec_type: 'audio', tags: { language: 'ukr' } },
    { index: 2, codec_type: 'audio', tags: { language: 'eng' } }
  ]);
  assert.equal(index, 2);
});

test('falls back to first audio stream when english is absent', () => {
  const index = pickAudioStreamIndex([
    { index: 0, codec_type: 'video' },
    { index: 1, codec_type: 'audio', tags: { language: 'ukr' } },
    { index: 2, codec_type: 'audio', tags: { language: 'rus' } }
  ]);
  assert.equal(index, 1);
});

test('throws when there is no audio stream', () => {
  assert.throws(() => pickAudioStreamIndex([{ index: 0, codec_type: 'video' }]));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceUrl } from '../src/proxy-service.js';

test('resolves valid source url', () => {
  assert.equal(resolveSourceUrl('https://cdn.example/video.mp4'), 'https://cdn.example/video.mp4');
});

test('throws on invalid protocol', () => {
  assert.throws(() => resolveSourceUrl('file:///tmp/a.mp4'));
});

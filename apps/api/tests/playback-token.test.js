import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackTokenService } from '../src/playback-token-service.js';

test('issues and consumes playback token', () => {
  const service = createPlaybackTokenService({
    secret: 'test-secret',
    ttlSec: 60,
    maxUses: 2
  });
  const issued = service.issue({
    sourceUrl: 'https://cdn.example/video.mp4'
  });
  assert.equal(typeof issued.token, 'string');
  assert.equal(Number.isFinite(Number(issued.expiresAt)), true);
  const first = service.consume(issued.token);
  assert.equal(first.sourceUrl, 'https://cdn.example/video.mp4');
  const second = service.consume(issued.token);
  assert.equal(second.sourceUrl, 'https://cdn.example/video.mp4');
  assert.throws(() => service.consume(issued.token));
});

test('rejects token with invalid signature', () => {
  const service = createPlaybackTokenService({
    secret: 'test-secret',
    ttlSec: 60
  });
  const issued = service.issue({
    sourceUrl: 'https://cdn.example/video.mp4'
  });
  const parts = issued.token.split('.');
  const tampered = `${parts[0]}.invalid`;
  assert.throws(() => service.consume(tampered));
});

test('expires tokens according to ttl', async () => {
  const service = createPlaybackTokenService({
    secret: 'test-secret',
    ttlSec: 1,
    maxUses: 8
  });
  const issued = service.issue({
    sourceUrl: 'https://cdn.example/video.mp4'
  });
  await new Promise((resolve) => {
    setTimeout(resolve, 1100);
  });
  assert.throws(() => service.consume(issued.token));
});

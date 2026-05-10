import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovieLogService } from '../src/movie-log-service.js';

test('appends entries with monotonic ids and exposes them via list', () => {
  const service = createMovieLogService({ maxEntries: 100 });
  const accepted = service.append([
    { stage: 'flow:start', payload: { url: 'foo' } },
    { stage: 'download:start' }
  ], { sessionId: 'sess-1', sourceUserAgent: 'Xbox' });
  assert.equal(accepted, 2);
  const entries = service.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id < entries[1].id, true);
  assert.equal(entries[0].sessionId, 'sess-1');
  assert.equal(entries[0].sourceUserAgent, 'Xbox');
  assert.equal(entries[0].payload.includes('"url":"foo"'), true);
});

test('drops oldest entries when ring buffer exceeds limit', () => {
  const service = createMovieLogService({ maxEntries: 3 });
  service.append([
    { stage: 'a' },
    { stage: 'b' },
    { stage: 'c' },
    { stage: 'd' },
    { stage: 'e' }
  ]);
  const stages = service.list().map((entry) => entry.stage);
  assert.deepEqual(stages, ['c', 'd', 'e']);
});

test('list filters by session and id since', () => {
  const service = createMovieLogService({ maxEntries: 100 });
  service.append([{ stage: 'a' }], { sessionId: 's1' });
  service.append([{ stage: 'b' }], { sessionId: 's2' });
  service.append([{ stage: 'c' }], { sessionId: 's1' });
  const sess1 = service.list({ session: 's1' });
  assert.deepEqual(sess1.map((entry) => entry.stage), ['a', 'c']);
  const since = service.list({ since: sess1[0].id });
  assert.equal(since.length >= 2, true);
  assert.equal(since.every((entry) => entry.id > sess1[0].id), true);
});

test('listSessions aggregates by sessionId with last activity', async () => {
  const service = createMovieLogService({ maxEntries: 100 });
  service.append([{ stage: 'a' }], { sessionId: 's1', sourceUserAgent: 'Xbox' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.append([{ stage: 'b' }], { sessionId: 's2', sourceUserAgent: 'Mac' });
  const sessions = service.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sessionId, 's2');
  assert.equal(sessions[1].entries, 1);
});

test('clamps long payload strings to byte limit', () => {
  const service = createMovieLogService({ maxEntries: 10, maxPayloadBytes: 32 });
  service.append([{ stage: 'a', payload: 'x'.repeat(500) }]);
  const entries = service.list();
  assert.equal(entries[0].payload.length <= 34, true);
});

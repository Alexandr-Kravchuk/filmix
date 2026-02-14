import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFixedEpisode, getApiBaseUrl } from '../src/api.js';

test('uses localhost api base by default', () => {
  assert.equal(getApiBaseUrl(), 'http://localhost:3000');
});

test('exports fixed episode loader', () => {
  assert.equal(typeof fetchFixedEpisode, 'function');
});

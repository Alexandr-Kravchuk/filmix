import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchShow, fetchSourceByEpisode, getApiBaseUrl } from '../src/api.js';

test('uses localhost api base by default', () => {
  assert.equal(getApiBaseUrl(), 'http://localhost:3000');
});

test('exports show loader', () => {
  assert.equal(typeof fetchShow, 'function');
});
test('exports episode source loader', () => {
  assert.equal(typeof fetchSourceByEpisode, 'function');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutputCacheId } from '../src/task-queue.js';

test('normalizes signed source urls to stable output cache key', () => {
  const first = buildOutputCacheId(
    5,
    11,
    'https://nl201.cdnsqu.com/s/FHYjxHq0I8adhYTlt7jY9dd0FBQUFBSld1TUVFUmRISEF3NkRWb1pBQg.rcc8es0rbgWlx3whOYzUoibjFtKRYKRKFVyWtg/paw.patrol.2013.dub.ukr/s05e11_1080.mp4?user=1093269'
  );
  const second = buildOutputCacheId(
    5,
    11,
    'https://nl201.cdnsqu.com/s/FH4T0GeZpA7O7pYxhSKLywwUFBQUFBSld1TUVFUmRISFFRYURWb1pBQg.FXy7-fq-Ss5OsNogr4RxWTbnemJmGrQ67LgLpA/paw.patrol.2013.dub.ukr/s05e11_1080.mp4?user=8888'
  );
  assert.equal(first, second);
});

test('keeps quality difference in output cache key', () => {
  const low = buildOutputCacheId(
    5,
    11,
    'https://nl201.cdnsqu.com/s/abc/paw.patrol.2013.dub.ukr/s05e11_480.mp4?user=1093269'
  );
  const high = buildOutputCacheId(
    5,
    11,
    'https://nl201.cdnsqu.com/s/def/paw.patrol.2013.dub.ukr/s05e11_1080.mp4?user=1093269'
  );
  assert.notEqual(low, high);
});


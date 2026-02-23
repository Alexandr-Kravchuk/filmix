import process from 'node:process';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      result[key] = 'true';
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function asInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { response, text, data };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const apiBase = normalizeBaseUrl(args.api || args.apiBase || args.api_base || 'http://localhost:3000');
  const webUrl = args.web || args.webUrl || args.web_url || '';
  const season = asInteger(args.season, 5);
  const episode = asInteger(args.episode, 11);
  const qualityRaw = String(args.quality || 'max').trim().toLowerCase();
  process.stdout.write(`Smoke API base: ${apiBase}\n`);
  const health = await requestJson(`${apiBase}/api/health`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!health.response.ok || !health.data || health.data.ok !== true) {
    fail(`Health check failed: HTTP ${health.response.status} ${health.text}`);
  }
  process.stdout.write('Health check passed\n');
  const fixedEpisode = await requestJson(`${apiBase}/api/fixed-episode`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!fixedEpisode.response.ok || !fixedEpisode.data) {
    fail(`Fixed episode failed: HTTP ${fixedEpisode.response.status} ${fixedEpisode.text}`);
  }
  const playUrl = String(fixedEpisode.data.playUrl || '');
  if (!playUrl.startsWith('/api/stream/')) {
    fail(`Unexpected playUrl format: ${playUrl}`);
  }
  const resolvedUrl = new URL(playUrl, `${apiBase}/`);
  process.stdout.write(`Fixed episode playback token check passed: ${qualityRaw}\n`);
  const sourceBatch = await requestJson(`${apiBase}/api/source-batch?season=${season}&episodes=${episode}`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!sourceBatch.response.ok || !sourceBatch.data || !Array.isArray(sourceBatch.data.items)) {
    fail(`Source batch check failed: HTTP ${sourceBatch.response.status} ${sourceBatch.text}`);
  }
  const batchItem = sourceBatch.data.items.find((item) => Number.parseInt(String(item.episode || ''), 10) === episode);
  if (!batchItem || typeof batchItem.playbackUrl !== 'string' || !batchItem.playbackUrl.startsWith('/api/stream/')) {
    fail('Source batch does not include tokenized playback url');
  }
  process.stdout.write(`Source batch check passed: ${qualityRaw}\n`);
  const sourceLadder = await requestJson(`${apiBase}/api/source-ladder?season=${season}&episode=${episode}`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!sourceLadder.response.ok || !sourceLadder.data || !Array.isArray(sourceLadder.data.sources)) {
    fail(`Source ladder check failed: HTTP ${sourceLadder.response.status} ${sourceLadder.text}`);
  }
  const ladderMatch = sourceLadder.data.sources.some((item) => typeof item.playbackUrl === 'string' && item.playbackUrl.startsWith('/api/stream/'));
  if (!ladderMatch) {
    fail('Source ladder does not include tokenized playback url');
  }
  process.stdout.write(`Source ladder check passed: ${qualityRaw}\n`);
  const proxyResponse = await fetch(resolvedUrl, {
    headers: {
      Range: 'bytes=0-1'
    }
  });
  if (proxyResponse.status !== 206) {
    fail(`Proxy Range check failed: expected 206, got ${proxyResponse.status}`);
  }
  const contentRange = proxyResponse.headers.get('content-range') || '';
  if (!contentRange.startsWith('bytes 0-1/')) {
    fail(`Proxy Range response missing expected content-range: ${contentRange}`);
  }
  process.stdout.write(`Proxy Range check passed: ${contentRange}\n`);
  if (webUrl) {
    const webResponse = await fetch(webUrl);
    const webText = await webResponse.text();
    if (!webResponse.ok) {
      fail(`Web check failed: HTTP ${webResponse.status}`);
    }
    if (!webText.includes('id="video"')) {
      fail('Web check failed: video element was not found');
    }
    process.stdout.write(`Web check passed: ${webUrl}\n`);
  }
  process.stdout.write('Smoke check passed\n');
}

run().catch((error) => {
  fail(`Smoke check failed: ${error.message}`);
});

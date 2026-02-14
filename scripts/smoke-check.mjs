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
  const quality = asInteger(args.quality, 480);
  process.stdout.write(`Smoke API base: ${apiBase}\n`);
  const health = await requestJson(`${apiBase}/api/health`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!health.response.ok || !health.data || health.data.ok !== true) {
    fail(`Health check failed: HTTP ${health.response.status} ${health.text}`);
  }
  process.stdout.write(`Health check passed: version=${health.data.version}\n`);
  const fixedEpisode = await requestJson(`${apiBase}/api/fixed-episode`, {
    headers: {
      Accept: 'application/json'
    }
  });
  if (!fixedEpisode.response.ok || !fixedEpisode.data) {
    fail(`Fixed episode failed: HTTP ${fixedEpisode.response.status} ${fixedEpisode.text}`);
  }
  const playUrl = String(fixedEpisode.data.playUrl || '');
  if (!playUrl.startsWith('/proxy/video?src=')) {
    fail(`Unexpected playUrl format: ${playUrl}`);
  }
  const resolvedUrl = new URL(playUrl, `${apiBase}/`);
  const encodedSrc = resolvedUrl.searchParams.get('src') || '';
  const sourceUrl = decodeURIComponent(encodedSrc);
  const expectedToken = `s${String(season).padStart(2, '0')}e${String(episode).padStart(2, '0')}_${quality}.mp4`;
  if (!sourceUrl.includes(expectedToken)) {
    fail(`Source URL does not include expected episode token ${expectedToken}: ${sourceUrl}`);
  }
  process.stdout.write(`Fixed episode source token check passed: ${expectedToken}\n`);
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

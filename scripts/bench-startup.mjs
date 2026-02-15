import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';

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
function asInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}
function normalizeWebUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return 'http://localhost:5173';
  }
  return normalized.replace(/\/+$/, '');
}
function formatEpisodeCode(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}
function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}
function percentile(values, p) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}
function round(value) {
  return Math.round(Number(value) || 0);
}
function summarize(values) {
  if (!values.length) {
    return {
      count: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p95: 0
    };
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    mean: round(sum / values.length),
    median: round(median(values)),
    p95: round(percentile(values, 95))
  };
}
function readStatusSnapshot() {
  const status = String(document.getElementById('status')?.textContent || '').trim();
  const background = String(document.getElementById('background-status')?.textContent || '').trim();
  return { status, background };
}
async function waitForCatalogReady(page, timeoutMs) {
  await page.waitForFunction(() => {
    const season = document.getElementById('season-select');
    const episode = document.getElementById('episode-select');
    const play = document.getElementById('play-btn');
    if (!season || !episode || !play) {
      return false;
    }
    return !season.disabled && !episode.disabled && season.options.length > 0 && episode.options.length > 0;
  }, null, { timeout: timeoutMs });
}
async function selectEpisode(page, season, episode, timeoutMs) {
  await page.selectOption('#season-select', String(season));
  await page.waitForTimeout(80);
  await page.waitForFunction((targetEpisode) => {
    const episodeSelect = document.getElementById('episode-select');
    if (!episodeSelect || episodeSelect.disabled) {
      return false;
    }
    return Array.from(episodeSelect.options).some((option) => option.value === String(targetEpisode));
  }, episode, { timeout: timeoutMs });
  await page.selectOption('#episode-select', String(episode));
  await page.waitForTimeout(80);
}
async function runPlaybackProbe(page, config) {
  const code = formatEpisodeCode(config.season, config.episode);
  const startedAt = Date.now();
  await page.click('#play-btn');
  await page.waitForFunction((targetCode) => {
    const status = String(document.getElementById('status')?.textContent || '');
    return status.includes(`Playing ${targetCode} in`) || status.includes('Autoplay blocked') || status.includes('Playback blocked');
  }, code, { timeout: config.playStartTimeoutMs });
  const firstPlayingMs = Date.now() - startedAt;
  const firstSnapshot = await page.evaluate(readStatusSnapshot);
  let maxSwitchMs = null;
  try {
    await page.waitForFunction(() => {
      const status = String(document.getElementById('status')?.textContent || '');
      const background = String(document.getElementById('background-status')?.textContent || '');
      return status.includes('Switched to') || background.includes('HD ready') || background.includes('HD preparation failed');
    }, null, { timeout: config.maxSwitchTimeoutMs });
    maxSwitchMs = Date.now() - startedAt;
  } catch {
    maxSwitchMs = null;
  }
  const finalSnapshot = await page.evaluate(readStatusSnapshot);
  return {
    playClickToFirstPlayingMs: firstPlayingMs,
    playClickTo480ReadyMs: firstPlayingMs,
    playClickToMaxSwitchMs: maxSwitchMs,
    firstStatus: firstSnapshot.status,
    firstBackgroundStatus: firstSnapshot.background,
    finalStatus: finalSnapshot.status,
    finalBackgroundStatus: finalSnapshot.background
  };
}
async function runSingleIteration(browser, config, phase, index, sharedContext = null) {
  const context = sharedContext || await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });
  const page = await context.newPage();
  try {
    await page.goto(config.webUrl, { waitUntil: 'domcontentloaded', timeout: config.pageLoadTimeoutMs });
    await waitForCatalogReady(page, config.catalogTimeoutMs);
    await selectEpisode(page, config.season, config.episode, config.catalogTimeoutMs);
    const result = await runPlaybackProbe(page, config);
    const payload = {
      phase,
      index,
      season: config.season,
      episode: config.episode,
      ...result
    };
    const startMs = payload.playClickToFirstPlayingMs;
    const maxMs = payload.playClickToMaxSwitchMs === null ? 'n/a' : `${payload.playClickToMaxSwitchMs}ms`;
    process.stdout.write(`[${phase} #${index}] start=${startMs}ms max=${maxMs} first="${payload.firstStatus}" final="${payload.finalStatus}"\n`);
    return payload;
  } finally {
    await page.close();
    if (!sharedContext) {
      await context.close();
    }
  }
}
async function runWarmupPrimer(browser, config) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });
  const primer = await runSingleIteration(browser, config, 'warm-primer', 0, context).catch(() => null);
  if (primer) {
    process.stdout.write(`[warm-primer] start=${primer.playClickToFirstPlayingMs}ms\n`);
  }
  return context;
}
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright is not installed. Run "npm install -D playwright" and "npx playwright install chromium".');
  }
}
async function run() {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    webUrl: normalizeWebUrl(args.web || args.webUrl || args.web_url),
    season: asInteger(args.season, 5),
    episode: asInteger(args.episode, 11),
    coldRuns: Math.max(1, asInteger(args.cold || args.coldRuns || args.cold_runs, 3)),
    warmRuns: Math.max(1, asInteger(args.warm || args.warmRuns || args.warm_runs, 5)),
    pageLoadTimeoutMs: Math.max(1000, asInteger(args.pageTimeoutMs || args.page_timeout_ms, 120000)),
    catalogTimeoutMs: Math.max(1000, asInteger(args.catalogTimeoutMs || args.catalog_timeout_ms, 180000)),
    playStartTimeoutMs: Math.max(1000, asInteger(args.playStartTimeoutMs || args.play_start_timeout_ms, 240000)),
    maxSwitchTimeoutMs: Math.max(1000, asInteger(args.maxSwitchTimeoutMs || args.max_switch_timeout_ms, 480000)),
    browserChannel: String(args.channel || args.browserChannel || args.browser_channel || 'chrome').trim(),
    headless: String(args.headless || 'true').trim().toLowerCase() !== 'false'
  };
  const playwright = await loadPlaywright();
  const launchOptions = { headless: config.headless };
  if (config.browserChannel && config.browserChannel !== 'auto') {
    launchOptions.channel = config.browserChannel;
  }
  const browser = await playwright.chromium.launch(launchOptions);
  const startedAt = Date.now();
  const coldResults = [];
  const warmResults = [];
  process.stdout.write(`Bench target: ${config.webUrl}\n`);
  process.stdout.write(`Episode: ${formatEpisodeCode(config.season, config.episode)}\n`);
  process.stdout.write(`Runs: cold=${config.coldRuns}, warm=${config.warmRuns}\n`);
  try {
    for (let index = 1; index <= config.coldRuns; index += 1) {
      const result = await runSingleIteration(browser, config, 'cold', index);
      coldResults.push(result);
    }
    const warmContext = await runWarmupPrimer(browser, config);
    try {
      for (let index = 1; index <= config.warmRuns; index += 1) {
        const result = await runSingleIteration(browser, config, 'warm', index, warmContext);
        warmResults.push(result);
      }
    } finally {
      await warmContext.close();
    }
  } finally {
    await browser.close();
  }
  const firstPlayingCold = coldResults.map((item) => item.playClickToFirstPlayingMs);
  const firstPlayingWarm = warmResults.map((item) => item.playClickToFirstPlayingMs);
  const maxSwitchCold = coldResults.map((item) => item.playClickToMaxSwitchMs).filter((item) => Number.isFinite(item));
  const maxSwitchWarm = warmResults.map((item) => item.playClickToMaxSwitchMs).filter((item) => Number.isFinite(item));
  const summary = {
    cold: {
      firstPlayingMs: summarize(firstPlayingCold),
      maxSwitchMs: summarize(maxSwitchCold)
    },
    warm: {
      firstPlayingMs: summarize(firstPlayingWarm),
      maxSwitchMs: summarize(maxSwitchWarm)
    }
  };
  const output = {
    generatedAt: Date.now(),
    totalDurationMs: Date.now() - startedAt,
    config,
    summary,
    runs: {
      cold: coldResults,
      warm: warmResults
    }
  };
  const outDir = path.resolve(process.cwd(), 'tmp/bench-results');
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, `bench-startup-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`);
  await writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`Output: ${outFile}\n`);
  process.stdout.write(`Cold median play->start: ${summary.cold.firstPlayingMs.median}ms\n`);
  process.stdout.write(`Warm median play->start: ${summary.warm.firstPlayingMs.median}ms\n`);
}

run().catch((error) => {
  process.stderr.write(`Benchmark failed: ${error.message}\n`);
  process.exit(1);
});

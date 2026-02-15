import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { FilmixClient } from './filmix-client.js';
import { createCatalog, getEpisodeData } from './catalog-service.js';
import { getDefaultEnglishMapPath, loadEnglishMap, saveEnglishMap } from './english-map-service.js';
import { parseHarToEnglishMap } from './har-import-service.js';
import { resolveEpisodeSourceFromPlayerData } from './playerjs-service.js';
import { proxyVideoRequest } from './proxy-service.js';
import { proxyVideoEnglishAudio } from './ffmpeg-service.js';

function loadEnvFiles() {
  dotenv.config({ path: path.resolve(process.cwd(), 'apps/api/.env') });
  dotenv.config();
}

function parseCorsOrigins(value) {
  if (!value) {
    return [];
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin, allowedOrigins) {
  if (!origin) {
    return true;
  }
  if (origin.startsWith('http://localhost:')) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return defaultValue;
}
function parsePreferredQuality(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  if (!normalized || normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return Number.MAX_SAFE_INTEGER;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parsed;
}
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createApp(config) {
  const app = express();
  const mapPath = config.mapPath || getDefaultEnglishMapPath();
  const allowedOrigins = parseCorsOrigins(config.corsOrigin || '');
  const adminToken = config.adminToken || '';
  const fixedSeason = config.fixedSeason || 5;
  const fixedEpisode = config.fixedEpisode || 11;
  const fixedEnglishSource = config.fixedEnglishSource || '';
  const fixedLocalFilePath = config.fixedLocalFilePath || '';
  const fixedPublicMediaUrl = config.fixedPublicMediaUrl || '';
  const fixedPublicMediaViaProxy = config.fixedPublicMediaViaProxy !== false;
  const fixedQuality = Number.parseInt(String(config.fixedQuality || '480'), 10);
  const preferredTranslationPattern = config.preferredTranslationPattern || 'ukr|укра';
  const playlistFetch = config.playlistFetch || fetch;
  let cache = null;

  function toProxyPlayUrl(sourceUrl) {
    return `/proxy/video?src=${encodeURIComponent(sourceUrl)}`;
  }

  function getFixedPlayUrl() {
    if (fixedLocalFilePath) {
      return '/media/fixed-episode.mp4';
    }
    if (fixedPublicMediaUrl) {
      return fixedPublicMediaViaProxy ? toProxyPlayUrl(fixedPublicMediaUrl) : fixedPublicMediaUrl;
    }
    if (fixedEnglishSource) {
      return toProxyPlayUrl(fixedEnglishSource);
    }
    return '';
  }
  async function resolveFixedSourceData() {
    if (fixedLocalFilePath) {
      return {
        sourceUrl: '/media/fixed-episode.mp4',
        origin: 'fixed-local'
      };
    }
    if (fixedPublicMediaUrl) {
      return {
        sourceUrl: fixedPublicMediaUrl,
        origin: 'fixed-public'
      };
    }
    if (fixedEnglishSource) {
      return {
        sourceUrl: fixedEnglishSource,
        origin: 'fixed-env'
      };
    }
    const playerData = await config.filmixClient.getPlayerData();
    try {
      const resolved = await resolveEpisodeSourceFromPlayerData(playerData, {
        season: fixedSeason,
        episode: fixedEpisode,
        preferredQuality: fixedQuality,
        preferredTranslationPattern,
        userAgent: config.userAgent,
        fetchImpl: playlistFetch
      });
      return {
        sourceUrl: resolved.sourceUrl,
        origin: 'player-data'
      };
    } catch {
    }
    const catalog = await buildCatalogSnapshot();
    const data = getEpisodeData(catalog, fixedSeason, fixedEpisode);
    const source = data.sources.find((item) => item.lang === 'en');
    if (!source) {
      throw new Error('English source is not available for fixed episode');
    }
    return {
      sourceUrl: source.sourceUrl,
      origin: 'catalog'
    };
  }
  function pickCatalogSource(data) {
    const priority = ['uk', 'ru', 'en'];
    for (const lang of priority) {
      const source = data.sources.find((item) => item.lang === lang);
      if (source) {
        return source;
      }
    }
    return null;
  }
  async function resolveSourceDataForEpisode(season, episode) {
    if (season === fixedSeason && episode === fixedEpisode) {
      return resolveFixedSourceData();
    }
    const playerData = await config.filmixClient.getPlayerData();
    try {
      const resolved = await resolveEpisodeSourceFromPlayerData(playerData, {
        season,
        episode,
        preferredQuality: fixedQuality,
        preferredTranslationPattern,
        userAgent: config.userAgent,
        fetchImpl: playlistFetch
      });
      return {
        sourceUrl: resolved.sourceUrl,
        origin: 'player-data'
      };
    } catch {
    }
    const catalog = await buildCatalogSnapshot();
    const data = getEpisodeData(catalog, season, episode);
    const source = pickCatalogSource(data);
    if (!source) {
      const error = new Error('Episode not found or no sources available');
      error.statusCode = 404;
      throw error;
    }
    return {
      sourceUrl: source.sourceUrl,
      origin: 'catalog'
    };
  }

  async function sendLocalVideo(filePath, req, res) {
    const fileStat = await stat(filePath);
    const total = fileStat.size;
    const rangeHeader = String(req.headers.range || '');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'video/mp4');
    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!match) {
        res.status(416).end();
        return;
      }
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
        return;
      }
      const length = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(length));
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }
    res.status(200);
    res.setHeader('Content-Length', String(total));
    createReadStream(filePath).pipe(res);
  }

  async function buildCatalogSnapshot(force = false) {
    if (!force && cache && Date.now() - cache.createdAt < 60000) {
      return cache.value;
    }
    const [playerData, englishMap] = await Promise.all([
      config.filmixClient.getPlayerData(),
      loadEnglishMap(mapPath)
    ]);
    const catalog = createCatalog(playerData, {
      showTitle: config.showTitle,
      englishMap
    });
    cache = {
      createdAt: Date.now(),
      value: catalog
    };
    return catalog;
  }

  function resetCache() {
    cache = null;
  }

  app.use(express.json({ limit: '30mb' }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin, allowedOrigins)) {
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
      next();
      return;
    }
    res.status(403).json({ error: 'CORS origin is not allowed' });
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      version: config.version || 'dev'
    });
  });

  app.get('/api/show', async (req, res, next) => {
    try {
      const force = parseBoolean(req.query.force, false);
      const catalog = await buildCatalogSnapshot(force);
      res.json({
        title: catalog.title,
        seasons: catalog.seasons,
        episodesBySeason: catalog.episodesBySeason,
        fixed: {
          season: fixedSeason,
          episode: fixedEpisode
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/fixed-episode', async (req, res, next) => {
    try {
      const fixedPlayUrl = getFixedPlayUrl();
      if (fixedPlayUrl) {
        const sourceData = await resolveFixedSourceData();
        res.json({
          season: fixedSeason,
          episode: fixedEpisode,
          playUrl: fixedPlayUrl,
          sourceUrl: sourceData.sourceUrl,
          origin: sourceData.origin
        });
        return;
      }
      const sourceData = await resolveFixedSourceData();
      res.json({
        season: fixedSeason,
        episode: fixedEpisode,
        playUrl: toProxyPlayUrl(sourceData.sourceUrl),
        sourceUrl: sourceData.sourceUrl,
        origin: sourceData.origin
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/source', async (req, res, next) => {
    try {
      const hasSeason = Object.hasOwn(req.query, 'season');
      const hasEpisode = Object.hasOwn(req.query, 'episode');
      if (!hasSeason && !hasEpisode) {
        const sourceData = await resolveFixedSourceData();
        res.json({
          season: fixedSeason,
          episode: fixedEpisode,
          sourceUrl: sourceData.sourceUrl,
          origin: sourceData.origin
        });
        return;
      }
      const season = Number.parseInt(String(req.query.season || ''), 10);
      const episode = Number.parseInt(String(req.query.episode || ''), 10);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) {
        res.status(400).json({ error: 'season and episode are required integers' });
        return;
      }
      const sourceData = await resolveSourceDataForEpisode(season, episode);
      res.json({
        season,
        episode,
        sourceUrl: sourceData.sourceUrl,
        origin: sourceData.origin
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/episode', async (req, res, next) => {
    try {
      const season = Number.parseInt(String(req.query.season || ''), 10);
      const episode = Number.parseInt(String(req.query.episode || ''), 10);
      if (!Number.isFinite(season) || !Number.isFinite(episode)) {
        res.status(400).json({ error: 'season and episode are required integers' });
        return;
      }
      const catalog = await buildCatalogSnapshot();
      const data = getEpisodeData(catalog, season, episode);
      if (!data.sources.length) {
        res.status(404).json({ error: 'Episode not found or no sources available' });
        return;
      }
      res.json(data);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/play', async (req, res, next) => {
    try {
      const seasonQuery = Number.parseInt(String(req.query.season || ''), 10);
      const episodeQuery = Number.parseInt(String(req.query.episode || ''), 10);
      const season = Number.isFinite(seasonQuery) ? seasonQuery : fixedSeason;
      const episode = Number.isFinite(episodeQuery) ? episodeQuery : fixedEpisode;
      const lang = String(req.query.lang || 'en');
      const fixedPlayUrl = getFixedPlayUrl();
      if (!Number.isFinite(seasonQuery) && !Number.isFinite(episodeQuery) && lang === 'en' && fixedPlayUrl) {
        res.redirect(fixedPlayUrl);
        return;
      }
      const catalog = await buildCatalogSnapshot();
      const data = getEpisodeData(catalog, season, episode);
      const source = data.sources.find((item) => item.lang === lang);
      if (!source) {
        res.status(404).json({ error: 'Language source is not available' });
        return;
      }
      res.redirect(toProxyPlayUrl(source.sourceUrl));
    } catch (error) {
      next(error);
    }
  });
  app.get('/watch', (req, res) => {
    const src = String(req.query.src || '');
    if (!src) {
      res.status(400).send('Missing src query parameter');
      return;
    }
    const playUrl = `/proxy/video-en?src=${encodeURIComponent(src)}`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Video Player</title>
<style>
html,body{margin:0;height:100%;background:#0b1220;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
video{width:min(100%,1200px);max-height:90vh;background:#000}
</style>
</head>
<body>
<main>
<video controls playsinline preload="metadata" src="${escapeHtml(playUrl)}"></video>
</main>
</body>
</html>`;
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
  });

  app.get('/proxy/video', async (req, res, next) => {
    try {
      await proxyVideoRequest(req, res, {
        referer: config.pageUrl,
        userAgent: config.userAgent
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/proxy/video-en', async (req, res, next) => {
    try {
      await proxyVideoEnglishAudio(req, res, {
        referer: config.pageUrl,
        userAgent: config.userAgent,
        cacheDir: config.mediaCacheDir,
        ffmpegBin: config.ffmpegBin,
        ffprobeBin: config.ffprobeBin
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/media/fixed-episode.mp4', async (req, res, next) => {
    try {
      if (!fixedLocalFilePath) {
        res.status(404).json({ error: 'Fixed local media is not configured' });
        return;
      }
      await sendLocalVideo(fixedLocalFilePath, req, res);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/import-har', async (req, res, next) => {
    try {
      const authHeader = String(req.headers.authorization || '');
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
      if (!adminToken || token !== adminToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const existing = await loadEnglishMap(mapPath);
      const merged = parseHarToEnglishMap(req.body, { existingMap: existing });
      const saved = await saveEnglishMap(merged, mapPath);
      resetCache();
      res.json({
        ok: true,
        entries: Object.keys(saved).length
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    const message = error && error.message ? error.message : 'Internal Server Error';
    const statusCode = Number.parseInt(String(error && error.statusCode ? error.statusCode : ''), 10);
    const status = Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    res.status(status).json({ error: message });
  });

  return app;
}

export function createRuntimeConfig() {
  loadEnvFiles();
  const pageUrl = process.env.FILMIX_PAGE_URL || 'https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html';
  const userAgent = process.env.FILMIX_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  return {
    port: Number.parseInt(process.env.PORT || '3000', 10),
    version: process.env.APP_VERSION || process.env.RENDER_GIT_COMMIT || 'dev',
    corsOrigin: process.env.CORS_ORIGIN || '',
    adminToken: process.env.ADMIN_TOKEN || '',
    showTitle: process.env.SHOW_TITLE || 'PAW Patrol',
    fixedSeason: Number.parseInt(process.env.FIXED_SEASON || '5', 10),
    fixedEpisode: Number.parseInt(process.env.FIXED_EPISODE || '11', 10),
    fixedEnglishSource: process.env.FIXED_ENGLISH_SOURCE || '',
    fixedLocalFilePath: process.env.FIXED_LOCAL_FILE_PATH || '',
    fixedPublicMediaUrl: process.env.FIXED_PUBLIC_MEDIA_URL || '',
    fixedPublicMediaViaProxy: parseBoolean(process.env.FIXED_PUBLIC_MEDIA_VIA_PROXY, true),
    fixedQuality: parsePreferredQuality(process.env.FIXED_QUALITY || 'max'),
    preferredTranslationPattern: process.env.FILMIX_PREFERRED_TRANSLATION_PATTERN || 'ukr|укра',
    pageUrl,
    userAgent,
    mediaCacheDir: process.env.MEDIA_CACHE_DIR || '/tmp/filmix-cache',
    ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
    filmixClient: new FilmixClient({
      pageUrl,
      login: process.env.FILMIX_LOGIN || '',
      password: process.env.FILMIX_PASSWORD || '',
      userAgent,
      cookie: process.env.FILMIX_COOKIE || ''
    })
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = createRuntimeConfig();
  const app = createApp(config);
  app.listen(config.port, () => {
    process.stdout.write(`API listening on http://localhost:${config.port}\n`);
  });
}

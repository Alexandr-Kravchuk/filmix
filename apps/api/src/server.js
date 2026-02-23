import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, mkdir, readFile, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import express from 'express';
import { FilmixClient } from './filmix-client.js';
import { createCatalog, getEpisodeData } from './catalog-service.js';
import { getDefaultEnglishMapPath, loadEnglishMap, saveEnglishMap } from './english-map-service.js';
import { parseHarToEnglishMap } from './har-import-service.js';
import { resolveEpisodeSourceFromPlayerData } from './playerjs-service.js';
import { proxyVideoRequest } from './proxy-service.js';
import { createSourceCacheService } from './source-cache-service.js';
import { createPlaybackTokenService } from './playback-token-service.js';

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

function isAllowedOrigin(origin, allowedOrigins, allowLocalhostOrigins) {
  if (!origin) {
    return true;
  }
  if (allowLocalhostOrigins && origin.startsWith('http://localhost:')) {
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
  if (normalized === 'min' || normalized === 'lowest' || normalized === 'low') {
    return 1;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parsed;
}
function normalizePlaybackProgress(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const season = Number.parseInt(String(value.season || ''), 10);
  const episode = Number.parseInt(String(value.episode || ''), 10);
  const currentTimeRaw = Number(value.currentTime);
  const durationRaw = Number(value.duration);
  const updatedAtRaw = Number.parseInt(String(value.updatedAt || ''), 10);
  if (!Number.isFinite(season) || season <= 0 || !Number.isFinite(episode) || episode <= 0) {
    return null;
  }
  if (!Number.isFinite(currentTimeRaw) || currentTimeRaw < 0) {
    return null;
  }
  const duration = Number.isFinite(durationRaw) && durationRaw >= 0 ? durationRaw : 0;
  const currentTime = duration > 0 ? Math.min(currentTimeRaw, duration) : currentTimeRaw;
  const updatedAt = Number.isFinite(updatedAtRaw) && updatedAtRaw > 0 ? updatedAtRaw : Date.now();
  return {
    season,
    episode,
    currentTime: Number(currentTime.toFixed(3)),
    duration: Number(duration.toFixed(3)),
    updatedAt
  };
}
function getEmptyPlaybackProgress() {
  return {
    season: null,
    episode: null,
    currentTime: 0,
    duration: 0,
    updatedAt: 0
  };
}
function parseProgressBody(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    return value;
  }
  return null;
}
function parsePositiveIntegerStrict(value) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}
function parseEpisodesCsv(value) {
  return Array.from(new Set(String(value || '')
    .split(',')
    .map((part) => parsePositiveIntegerStrict(part))
    .filter((part) => Number.isFinite(part)))).sort((a, b) => a - b);
}
function parseQualityQuery(value, defaultValue = 'max') {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'max' || normalized === 'highest' || normalized === 'best') {
    return 'max';
  }
  if (normalized === 'min' || normalized === 'lowest' || normalized === 'low') {
    return '1';
  }
  const parsed = parsePositiveIntegerStrict(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return String(parsed);
}
function parseSourceQualityFromUrl(value) {
  const url = String(value || '');
  const match = url.match(/_(\d+)\.mp4(?:$|[?&#])/i);
  if (!match) {
    return 0;
  }
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}
function pickSourceByQuality(sources, preferredQuality) {
  const normalized = [...(Array.isArray(sources) ? sources : [])]
    .filter((source) => source && typeof source.sourceUrl === 'string' && source.sourceUrl)
    .map((source) => ({
      quality: Number.isFinite(Number(source.quality)) ? Number.parseInt(String(source.quality), 10) : 0,
      sourceUrl: source.sourceUrl,
      origin: source.origin || ''
    }))
    .sort((a, b) => a.quality - b.quality);
  if (!normalized.length) {
    return null;
  }
  if (preferredQuality === 'max') {
    return normalized.at(-1);
  }
  const target = Number.parseInt(String(preferredQuality || ''), 10);
  if (!Number.isFinite(target) || target <= 0) {
    return normalized.at(-1);
  }
  const exact = normalized.find((source) => source.quality === target);
  if (exact) {
    return exact;
  }
  const lower = [...normalized].reverse().find((source) => source.quality < target);
  if (lower) {
    return lower;
  }
  return normalized[0];
}
function createRateLimiter(config = {}) {
  const windowMs = Number.parseInt(String(config.windowMs || '60000'), 10);
  const maxRequests = Number.parseInt(String(config.maxRequests || '60'), 10);
  const safeWindowMs = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60000;
  const safeMaxRequests = Number.isFinite(maxRequests) && maxRequests > 0 ? maxRequests : 60;
  const entries = new Map();
  return function checkRateLimit(key, now = Date.now()) {
    const normalizedKey = String(key || '').trim() || 'global';
    const existing = entries.get(normalizedKey);
    if (!existing || now >= existing.resetAt) {
      entries.set(normalizedKey, {
        count: 1,
        resetAt: now + safeWindowMs
      });
      return false;
    }
    existing.count += 1;
    if (existing.count > safeMaxRequests) {
      return true;
    }
    entries.set(normalizedKey, existing);
    return false;
  };
}
function buildSourceKey(value) {
  const normalized = String(value || '');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
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
  const fixedQuality = Number.parseInt(String(config.fixedQuality || '480'), 10);
  const preferredTranslationPattern = config.preferredTranslationPattern || 'ukr|укра';
  const playbackProgressPath = config.playbackProgressPath || '/tmp/filmix-playback-progress.json';
  const allowLocalhostOrigins = config.allowLocalhostOrigins !== false;
  const exposeHealthVersion = config.exposeHealthVersion === true;
  const nodeEnv = String(config.nodeEnv || process.env.NODE_ENV || '').trim().toLowerCase();
  const defaultPlaybackSecret = nodeEnv === 'production' ? '' : 'dev-playback-token-secret';
  const sourceCacheTtlMs = Number.parseInt(String(config.sourceCacheTtlMs || '1800000'), 10);
  const playlistCacheTtlMs = Number.parseInt(String(config.playlistCacheTtlMs || '600000'), 10);
  const playerDataCacheTtlMs = Number.parseInt(String(config.playerDataCacheTtlMs || '60000'), 10);
  const playlistFetch = config.playlistFetch || fetch;
  const playbackTokenService = createPlaybackTokenService({
    secret: config.playbackTokenSecret || defaultPlaybackSecret,
    ttlSec: Number.parseInt(String(config.playbackTokenTtlSec || '60'), 10),
    maxUses: Number.parseInt(String(config.playbackTokenMaxUses || '256'), 10)
  });
  const checkRateLimit = createRateLimiter({
    windowMs: Number.parseInt(String(config.rateLimitWindowMs || '60000'), 10),
    maxRequests: Number.parseInt(String(config.rateLimitMaxRequests || '60'), 10)
  });
  let cache = null;
  let playbackProgress = null;
  let playbackProgressLoaded = false;
  let playbackProgressLoadPromise = null;

  function setSensitiveNoStore(res) {
    res.setHeader('Cache-Control', 'no-store');
  }
  function buildStreamUrl(token) {
    return `/api/stream/${encodeURIComponent(token)}`;
  }
  function createPlaybackDescriptor(sourceData) {
    const issued = playbackTokenService.issue({
      sourceUrl: sourceData.sourceUrl || '',
      localFilePath: sourceData.localFilePath || '',
      sourceKey: sourceData.sourceKey || '',
      origin: sourceData.origin || ''
    });
    return {
      playbackToken: issued.token,
      playbackUrl: buildStreamUrl(issued.token),
      expiresAt: issued.expiresAt
    };
  }
  function createSourceResponsePayload(season, episode, sourceData, quality, extra = {}) {
    const descriptor = createPlaybackDescriptor(sourceData);
    return {
      season,
      episode,
      quality,
      origin: sourceData.origin || '',
      sourceKey: sourceData.sourceKey || '',
      ...descriptor,
      ...extra
    };
  }
  function getStrictSeasonEpisode(query) {
    const season = parsePositiveIntegerStrict(query.season);
    const episode = parsePositiveIntegerStrict(query.episode);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) {
      return null;
    }
    return {
      season,
      episode
    };
  }
  async function resolveFixedSourceData() {
    if (fixedLocalFilePath) {
      const localQuality = parseSourceQualityFromUrl(fixedLocalFilePath);
      const fallbackQuality = Number.isFinite(fixedQuality) && fixedQuality > 0 && fixedQuality < Number.MAX_SAFE_INTEGER ? fixedQuality : 0;
      return {
        sourceUrl: '',
        localFilePath: fixedLocalFilePath,
        origin: 'fixed-local',
        sourceKey: buildSourceKey(`local:${fixedLocalFilePath}`),
        quality: localQuality > 0 ? localQuality : fallbackQuality
      };
    }
    if (fixedPublicMediaUrl) {
      return {
        sourceUrl: fixedPublicMediaUrl,
        localFilePath: '',
        origin: 'fixed-public',
        sourceKey: buildSourceKey(fixedPublicMediaUrl),
        quality: parseSourceQualityFromUrl(fixedPublicMediaUrl)
      };
    }
    if (fixedEnglishSource) {
      return {
        sourceUrl: fixedEnglishSource,
        localFilePath: '',
        origin: 'fixed-env',
        sourceKey: buildSourceKey(fixedEnglishSource),
        quality: parseSourceQualityFromUrl(fixedEnglishSource)
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
        localFilePath: '',
        origin: 'player-data',
        sourceKey: buildSourceKey(resolved.sourceUrl),
        quality: parseSourceQualityFromUrl(resolved.sourceUrl)
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
      localFilePath: '',
      origin: 'catalog',
      sourceKey: buildSourceKey(source.sourceUrl),
      quality: parseSourceQualityFromUrl(source.sourceUrl)
    };
  }
  function pickCatalogSource(data) {
    return data.sources.find((item) => item.lang === 'en') || null;
  }
  async function resolveCatalogLadderData(season, episode, context = {}) {
    let catalog = null;
    if (context && context.playerData) {
      const englishMap = await loadEnglishMap(mapPath);
      catalog = createCatalog(context.playerData, {
        showTitle: config.showTitle,
        englishMap
      });
    } else {
      catalog = await buildCatalogSnapshot();
    }
    const data = getEpisodeData(catalog, season, episode);
    const source = pickCatalogSource(data);
    if (!source) {
      const error = new Error('Episode not found or no sources available');
      error.statusCode = 404;
      throw error;
    }
    return {
      sources: [{
        quality: parseSourceQualityFromUrl(source.sourceUrl),
        sourceUrl: source.sourceUrl,
        origin: 'catalog'
      }],
      origin: 'catalog'
    };
  }
  async function resolveCatalogSourceData(season, episode, context = {}, preferredQuality = 'max') {
    const ladder = await resolveCatalogLadderData(season, episode, context);
    const selected = pickSourceByQuality(ladder.sources, preferredQuality);
    if (!selected) {
      const error = new Error('Episode not found or no sources available');
      error.statusCode = 404;
      throw error;
    }
    return selected;
  }
  const sourceCacheService = createSourceCacheService({
    fetchPlayerData: async () => config.filmixClient.getPlayerData(),
    fetchImpl: playlistFetch,
    preferredQuality: fixedQuality,
    preferredTranslationPattern,
    userAgent: config.userAgent,
    sourceCacheTtlMs,
    playlistCacheTtlMs,
    playerDataCacheTtlMs,
    resolveCatalogSource: resolveCatalogSourceData,
    resolveCatalogLadder: resolveCatalogLadderData
  });
  async function resolveSourceDataForEpisode(season, episode, preferredQuality = 'max') {
    if (season === fixedSeason && episode === fixedEpisode && (fixedLocalFilePath || fixedPublicMediaUrl || fixedEnglishSource)) {
      return resolveFixedSourceData();
    }
    const resolved = await sourceCacheService.resolveEpisodeSource(season, episode, preferredQuality);
    return {
      ...resolved,
      localFilePath: '',
      sourceKey: buildSourceKey(resolved.sourceUrl)
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
    sourceCacheService.clear();
  }
  async function loadPlaybackProgressFromDisk() {
    try {
      const raw = await readFile(playbackProgressPath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizePlaybackProgress(parsed);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return null;
      }
      return null;
    }
  }
  async function ensurePlaybackProgressLoaded() {
    if (playbackProgressLoaded) {
      return;
    }
    if (playbackProgressLoadPromise) {
      await playbackProgressLoadPromise;
      return;
    }
    playbackProgressLoadPromise = (async () => {
      playbackProgress = await loadPlaybackProgressFromDisk();
      playbackProgressLoaded = true;
    })();
    try {
      await playbackProgressLoadPromise;
    } finally {
      playbackProgressLoadPromise = null;
    }
  }
  async function persistPlaybackProgress(progress) {
    playbackProgress = progress;
    const dir = path.dirname(playbackProgressPath);
    await mkdir(dir, { recursive: true });
    await writeFile(playbackProgressPath, `${JSON.stringify(progress)}\n`, 'utf8');
  }
  function setMetadataCacheHeader(res) {
    res.setHeader('Cache-Control', 'public, max-age=30');
  }

  app.use(express.json({ limit: '30mb' }));
  app.use('/api/progress', express.text({ type: 'text/plain', limit: '20kb' }));

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin, allowedOrigins, allowLocalhostOrigins)) {
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
  app.use((req, res, next) => {
    const route = String(req.path || '');
    if (!route.startsWith('/api/source')
      && !route.startsWith('/api/episode')
      && !route.startsWith('/api/playback-token')
      && !route.startsWith('/api/stream/')
      && route !== '/api/play'
      && route !== '/api/fixed-episode') {
      next();
      return;
    }
    const ip = String(req.headers['x-forwarded-for'] || req.ip || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const key = `${ip}:${route}`;
    if (checkRateLimit(key)) {
      setSensitiveNoStore(res);
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  });

  app.get('/api/health', (req, res) => {
    const payload = { ok: true };
    if (exposeHealthVersion) {
      payload.version = config.version || 'dev';
    }
    res.json(payload);
  });
  app.get('/api/progress', async (req, res, next) => {
    try {
      await ensurePlaybackProgressLoaded();
      res.json(playbackProgress || getEmptyPlaybackProgress());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/progress', async (req, res, next) => {
    try {
      const progressBody = parseProgressBody(req.body);
      const nextProgress = normalizePlaybackProgress(progressBody);
      if (!nextProgress) {
        res.status(400).json({ error: 'Invalid progress payload' });
        return;
      }
      await ensurePlaybackProgressLoaded();
      if (playbackProgress && nextProgress.updatedAt < playbackProgress.updatedAt) {
        res.json(playbackProgress);
        return;
      }
      await persistPlaybackProgress(nextProgress);
      res.json(playbackProgress);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/show', async (req, res, next) => {
    try {
      const force = parseBoolean(req.query.force, false);
      const catalog = await buildCatalogSnapshot(force);
      setMetadataCacheHeader(res);
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
      const sourceData = await resolveFixedSourceData();
      const quality = Number.isFinite(sourceData.quality) && sourceData.quality > 0
        ? sourceData.quality
        : parseSourceQualityFromUrl(sourceData.sourceUrl);
      const payload = createSourceResponsePayload(fixedSeason, fixedEpisode, sourceData, quality);
      setSensitiveNoStore(res);
      res.json({
        ...payload,
        playUrl: payload.playbackUrl
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/playback-token', async (req, res, next) => {
    try {
      const params = getStrictSeasonEpisode(req.body || {});
      if (!params) {
        res.status(400).json({ error: 'season and episode are required positive integers' });
        return;
      }
      const preferredQuality = parseQualityQuery(req.body && req.body.quality, 'max');
      if (!preferredQuality) {
        res.status(400).json({ error: 'quality must be integer or "max"' });
        return;
      }
      const sourceData = await resolveSourceDataForEpisode(params.season, params.episode, preferredQuality);
      const quality = Number.isFinite(sourceData.quality) && sourceData.quality > 0
        ? sourceData.quality
        : parseSourceQualityFromUrl(sourceData.sourceUrl);
      const payload = createSourceResponsePayload(params.season, params.episode, sourceData, quality);
      setSensitiveNoStore(res);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/source', async (req, res, next) => {
    try {
      const hasSeason = Object.hasOwn(req.query, 'season');
      const hasEpisode = Object.hasOwn(req.query, 'episode');
      const preferredQuality = parseQualityQuery(req.query.quality, 'max');
      if (!preferredQuality) {
        res.status(400).json({ error: 'quality must be integer or "max"' });
        return;
      }
      if (!hasSeason && !hasEpisode) {
        const sourceData = await resolveFixedSourceData();
        const quality = Number.isFinite(sourceData.quality) && sourceData.quality > 0
          ? sourceData.quality
          : parseSourceQualityFromUrl(sourceData.sourceUrl);
        const payload = createSourceResponsePayload(fixedSeason, fixedEpisode, sourceData, quality);
        setSensitiveNoStore(res);
        res.json(payload);
        return;
      }
      if (hasSeason !== hasEpisode) {
        res.status(400).json({ error: 'season and episode are required positive integers' });
        return;
      }
      const params = getStrictSeasonEpisode(req.query);
      if (!params) {
        res.status(400).json({ error: 'season and episode are required positive integers' });
        return;
      }
      const sourceData = await resolveSourceDataForEpisode(params.season, params.episode, preferredQuality);
      const quality = Number.isFinite(sourceData.quality) && sourceData.quality > 0
        ? sourceData.quality
        : parseSourceQualityFromUrl(sourceData.sourceUrl);
      const payload = createSourceResponsePayload(params.season, params.episode, sourceData, quality);
      setSensitiveNoStore(res);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/source-ladder', async (req, res, next) => {
    try {
      const params = getStrictSeasonEpisode(req.query);
      if (!params) {
        res.status(400).json({ error: 'season and episode are required positive integers' });
        return;
      }
      if (params.season === fixedSeason && params.episode === fixedEpisode && (fixedLocalFilePath || fixedPublicMediaUrl || fixedEnglishSource)) {
        const sourceData = await resolveFixedSourceData();
        const quality = Number.isFinite(sourceData.quality) && sourceData.quality > 0
          ? sourceData.quality
          : parseSourceQualityFromUrl(sourceData.sourceUrl);
        const entry = createSourceResponsePayload(params.season, params.episode, sourceData, quality);
        setSensitiveNoStore(res);
        res.json({
          season: params.season,
          episode: params.episode,
          bootstrapQuality: 480,
          maxQuality: quality,
          sources: [entry],
          generatedAt: Date.now()
        });
        return;
      }
      const ladder = await sourceCacheService.resolveEpisodeSourceLadder(params.season, params.episode);
      const normalizedSources = [...(Array.isArray(ladder.sources) ? ladder.sources : [])].sort((a, b) => a.quality - b.quality);
      const maxQualitySource = pickSourceByQuality(normalizedSources, 'max');
      const sources = normalizedSources.map((item) => {
        const sourceData = {
          sourceUrl: item.sourceUrl,
          localFilePath: '',
          origin: item.origin || ladder.origin || '',
          sourceKey: buildSourceKey(item.sourceUrl)
        };
        const quality = Number.isFinite(item.quality) && item.quality > 0 ? item.quality : parseSourceQualityFromUrl(item.sourceUrl);
        return createSourceResponsePayload(params.season, params.episode, sourceData, quality);
      });
      setSensitiveNoStore(res);
      res.json({
        season: params.season,
        episode: params.episode,
        bootstrapQuality: 480,
        maxQuality: maxQualitySource ? maxQualitySource.quality : 0,
        sources,
        generatedAt: Date.now()
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/source-batch', async (req, res, next) => {
    try {
      const season = parsePositiveIntegerStrict(req.query.season);
      const episodes = parseEpisodesCsv(req.query.episodes);
      const preferredQuality = parseQualityQuery(req.query.quality, 'max');
      if (!Number.isFinite(season)) {
        res.status(400).json({ error: 'season is required positive integer' });
        return;
      }
      if (!episodes.length) {
        res.status(400).json({ error: 'episodes must be a comma-separated integer list' });
        return;
      }
      if (!preferredQuality) {
        res.status(400).json({ error: 'quality must be integer or "max"' });
        return;
      }
      const resolvedItems = await sourceCacheService.resolveEpisodeSourcesBatch(season, episodes, preferredQuality);
      const items = resolvedItems.map((item) => {
        const sourceData = {
          sourceUrl: item.sourceUrl,
          localFilePath: '',
          origin: item.origin || '',
          sourceKey: buildSourceKey(item.sourceUrl)
        };
        const quality = Number.isFinite(item.quality) && item.quality > 0 ? item.quality : parseSourceQualityFromUrl(item.sourceUrl);
        const payload = createSourceResponsePayload(season, item.episode, sourceData, quality);
        return {
          episode: item.episode,
          quality: payload.quality,
          origin: payload.origin,
          sourceKey: payload.sourceKey,
          playbackToken: payload.playbackToken,
          playbackUrl: payload.playbackUrl,
          expiresAt: payload.expiresAt
        };
      });
      setSensitiveNoStore(res);
      res.json({
        season,
        items,
        generatedAt: Date.now()
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/episode', async (req, res, next) => {
    try {
      const params = getStrictSeasonEpisode(req.query);
      if (!params) {
        res.status(400).json({ error: 'season and episode are required positive integers' });
        return;
      }
      const catalog = await buildCatalogSnapshot();
      const data = getEpisodeData(catalog, params.season, params.episode);
      if (!data.sources.length) {
        res.status(404).json({ error: 'Episode not found or no sources available' });
        return;
      }
      setSensitiveNoStore(res);
      res.json({
        season: params.season,
        episode: params.episode,
        defaultLang: data.defaultLang,
        sources: data.sources.map((item) => ({
          lang: item.lang,
          label: item.label,
          quality: parseSourceQualityFromUrl(item.sourceUrl)
        }))
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/play', async (req, res, next) => {
    try {
      const hasSeason = Object.hasOwn(req.query, 'season');
      const hasEpisode = Object.hasOwn(req.query, 'episode');
      if (hasSeason !== hasEpisode) {
        res.status(400).json({ error: 'season and episode should be provided together' });
        return;
      }
      let season = fixedSeason;
      let episode = fixedEpisode;
      if (hasSeason && hasEpisode) {
        const parsed = getStrictSeasonEpisode(req.query);
        if (!parsed) {
          res.status(400).json({ error: 'season and episode are required positive integers' });
          return;
        }
        season = parsed.season;
        episode = parsed.episode;
      }
      const lang = String(req.query.lang || 'en').trim().toLowerCase();
      if (!/^[a-z]{2,3}$/.test(lang)) {
        res.status(400).json({ error: 'lang should be a 2-3 letter code' });
        return;
      }
      if (season === fixedSeason && episode === fixedEpisode && (fixedLocalFilePath || fixedPublicMediaUrl || fixedEnglishSource) && lang === 'en') {
        const fixedSource = await resolveFixedSourceData();
        const fixedQualityValue = Number.isFinite(fixedSource.quality) && fixedSource.quality > 0
          ? fixedSource.quality
          : parseSourceQualityFromUrl(fixedSource.sourceUrl);
        const payload = createSourceResponsePayload(season, episode, fixedSource, fixedQualityValue, { lang });
        setSensitiveNoStore(res);
        res.redirect(payload.playbackUrl);
        return;
      }
      const catalog = await buildCatalogSnapshot();
      const data = getEpisodeData(catalog, season, episode);
      const source = data.sources.find((item) => item.lang === lang);
      if (!source) {
        res.status(404).json({ error: 'Language source is not available' });
        return;
      }
      const sourceData = {
        sourceUrl: source.sourceUrl,
        localFilePath: '',
        origin: 'catalog',
        sourceKey: buildSourceKey(source.sourceUrl)
      };
      const payload = createSourceResponsePayload(season, episode, sourceData, parseSourceQualityFromUrl(source.sourceUrl), { lang });
      setSensitiveNoStore(res);
      res.redirect(payload.playbackUrl);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/stream/:token', async (req, res, next) => {
    try {
      const playbackData = playbackTokenService.consume(req.params.token);
      setSensitiveNoStore(res);
      if (playbackData.localFilePath) {
        await sendLocalVideo(playbackData.localFilePath, req, res);
        return;
      }
      await proxyVideoRequest(req, res, {
        sourceUrl: playbackData.sourceUrl,
        referer: config.pageUrl,
        userAgent: config.userAgent
      });
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
    nodeEnv: process.env.NODE_ENV || '',
    version: process.env.APP_VERSION || process.env.RENDER_GIT_COMMIT || 'dev',
    corsOrigin: process.env.CORS_ORIGIN || '',
    adminToken: process.env.ADMIN_TOKEN || '',
    showTitle: process.env.SHOW_TITLE || 'PAW Patrol',
    fixedSeason: Number.parseInt(process.env.FIXED_SEASON || '5', 10),
    fixedEpisode: Number.parseInt(process.env.FIXED_EPISODE || '11', 10),
    fixedEnglishSource: process.env.FIXED_ENGLISH_SOURCE || '',
    fixedLocalFilePath: process.env.FIXED_LOCAL_FILE_PATH || '',
    fixedPublicMediaUrl: process.env.FIXED_PUBLIC_MEDIA_URL || '',
    fixedQuality: parsePreferredQuality(process.env.FIXED_QUALITY || 'max'),
    preferredTranslationPattern: process.env.FILMIX_PREFERRED_TRANSLATION_PATTERN || 'ukr|укра',
    playbackProgressPath: process.env.PLAYBACK_PROGRESS_PATH || '/tmp/filmix-playback-progress.json',
    playbackTokenSecret: process.env.PLAYBACK_TOKEN_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-playback-token-secret'),
    playbackTokenTtlSec: Number.parseInt(process.env.PLAYBACK_TOKEN_TTL_SEC || '60', 10),
    playbackTokenMaxUses: Number.parseInt(process.env.PLAYBACK_TOKEN_MAX_USES || '256', 10),
    rateLimitWindowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMaxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '60', 10),
    exposeHealthVersion: parseBoolean(process.env.EXPOSE_HEALTH_VERSION, process.env.NODE_ENV !== 'production'),
    allowLocalhostOrigins: parseBoolean(process.env.ALLOW_LOCALHOST_ORIGINS, process.env.NODE_ENV !== 'production'),
    sourceCacheTtlMs: Number.parseInt(process.env.SOURCE_CACHE_TTL_MS || '1800000', 10),
    playlistCacheTtlMs: Number.parseInt(process.env.PLAYLIST_CACHE_TTL_MS || '600000', 10),
    playerDataCacheTtlMs: Number.parseInt(process.env.PLAYER_DATA_CACHE_TTL_MS || '60000', 10),
    pageUrl,
    userAgent,
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

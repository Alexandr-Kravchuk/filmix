import { Readable } from 'node:stream';

const passHeaders = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified'
];

export function resolveSourceUrl(rawSource) {
  if (!rawSource || typeof rawSource !== 'string') {
    throw new Error('Missing src parameter');
  }
  const source = rawSource.trim();
  const url = new URL(source);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Unsupported source protocol');
  }
  return url.toString();
}

export async function proxyVideoRequest(req, res, options = {}) {
  const sourceUrl = resolveSourceUrl(req.query.src);
  const headers = {};
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }
  if (options.userAgent) {
    headers['User-Agent'] = options.userAgent;
  }
  if (options.referer) {
    headers.Referer = options.referer;
  }
  const upstream = await fetch(sourceUrl, {
    method: 'GET',
    headers
  });
  res.status(upstream.status);
  for (const headerName of passHeaders) {
    const value = upstream.headers.get(headerName);
    if (value) {
      res.setHeader(headerName, value);
    }
  }
  if (!upstream.body) {
    res.end();
    return;
  }
  const stream = Readable.fromWeb(upstream.body);
  stream.pipe(res);
}

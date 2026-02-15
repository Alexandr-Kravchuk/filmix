# Filmix Web + API Monorepo

This repository contains a static frontend for GitHub Pages and a separate Node.js API for Render.

## Architecture

- `apps/web`: Vite + Vanilla JS frontend with season/episode picker and English playback only.
- `apps/api`: Express API with Filmix auth, catalog extraction, video proxy, and HAR import.
- `apps/api/data/english-map.json`: English source mapping by `season:episode` keys.

## Requirements

- Node.js 20+
- npm 10+

## Install

```bash
npm install
```

## Environment

Copy and fill API variables:

```bash
cp apps/api/.env.example apps/api/.env
```

Required values:

- `FILMIX_LOGIN`
- `FILMIX_PASSWORD`
- `FILMIX_PAGE_URL`
- `FILMIX_COOKIE` (recommended if Filmix blocks programmatic login)
- `FILMIX_PREFERRED_TRANSLATION_PATTERN` (default `ukr|укра`)
- `ADMIN_TOKEN`
- `CORS_ORIGIN`
- `FIXED_SEASON`
- `FIXED_EPISODE`
- `FIXED_QUALITY` (default `480`)
- `MEDIA_CACHE_DIR` (default `/tmp/filmix-cache`)
- `FFMPEG_BIN` (default `ffmpeg`)
- `FFPROBE_BIN` (default `ffprobe`)
- `FIXED_ENGLISH_SOURCE` (optional direct URL for one-episode mode)
- `FIXED_LOCAL_FILE_PATH` (optional absolute path to local MP4; highest priority for fixed-episode mode)
- `FIXED_PUBLIC_MEDIA_URL` (optional public S3/R2 URL for deploy mode)
- `FIXED_PUBLIC_MEDIA_VIA_PROXY` (`true` or `false`, default `true`)

Frontend build uses:

- `VITE_API_BASE_URL`

## Local run

Terminal 1:

```bash
npm run dev:api
```

Terminal 2:

```bash
npm run dev:web
```

Open:

- Web: `http://localhost:5173`
- API: `http://localhost:3000`

## Frontend-only mode (macOS Chrome)

You can run web app without API and prepare English track fully in browser via `ffmpeg.wasm`.

```bash
npm --workspace apps/web run dev
```

Open Vite URL, choose season and episode, then click `Play`.
The app downloads the source MP4, remuxes it to a single English audio track, and starts playback from resulting `blob:` video.

If source URL expires, export fresh `player-data` response (`text-*.txt` from Proxyman), load it with `Extract URL from player-data`, then run `Prepare English` again.

## API endpoints

- `GET /api/health`
- `GET /api/show`
- `GET /api/fixed-episode`
- `GET /api/source`
- `GET /api/source?season=5&episode=11`
- `GET /api/episode?season=1&episode=1`
- `GET /api/play`
- `GET /api/play?season=1&episode=1&lang=en`
- `GET /proxy/video?src=<encoded_url>`
- `GET /proxy/video-en?src=<encoded_url>`
- `GET /watch?src=<encoded_url>`
- `POST /api/admin/import-har` with `Authorization: Bearer <ADMIN_TOKEN>`

`/api/source` is a lightweight endpoint for GitHub Pages mode:

- without query params returns fixed episode source
- with `season` and `episode` returns source for selected episode

`/proxy/video-en` downloads source to local cache, remuxes to a single English audio track, then serves cached MP4 with `Range`.

Priority for fixed episode source:

1. `FIXED_LOCAL_FILE_PATH` -> `/media/fixed-episode.mp4`
2. `FIXED_PUBLIC_MEDIA_URL`
3. `FIXED_ENGLISH_SOURCE`
4. decoded Filmix `translations.video` (`#2`) -> playlist `.txt` -> episode `/s/.../sXXeYY_<quality>.mp4`
5. fallback to parsed Filmix catalog + english map

For real Filmix source mode, keep `FIXED_LOCAL_FILE_PATH`, `FIXED_PUBLIC_MEDIA_URL`, and `FIXED_ENGLISH_SOURCE` empty.
If API login does not return valid cookies, set `FILMIX_COOKIE` from browser request header for `POST /api/movies/player-data`.

If `FIXED_PUBLIC_MEDIA_URL` is used:

- `FIXED_PUBLIC_MEDIA_VIA_PROXY=true` -> frontend uses `/proxy/video?src=...` (no bucket CORS setup needed)
- `FIXED_PUBLIC_MEDIA_VIA_PROXY=false` -> frontend uses direct media URL (bucket/domain CORS must allow GitHub Pages origin)

## HAR import

CLI import:

```bash
node scripts/extract-english-from-har.mjs --input /path/to/capture.har --output apps/api/data/english-map.json
```

HTTP import:

```bash
curl -X POST http://localhost:3000/api/admin/import-har \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data @/path/to/capture.har
```

## Quality checks

```bash
npm run lint
npm run test
npm run build
```

## Smoke checks

Local smoke check:

```bash
npm run smoke:local
```

Remote smoke check:

```bash
node scripts/smoke-check.mjs \
  --api https://<render-domain> \
  --web https://<github-user>.github.io/<repo>/
```

## GitHub Pages deployment

- Workflow file: `.github/workflows/deploy-pages.yml`
- Frontend builds as standalone static app for frontend-only mode.

The Vite `base` path is auto-set to `/<repo>/` in GitHub Actions.

## Render deployment

- Blueprint file: `render.yaml`
- Service root: `apps/api`
- Health check: `/api/health`
- Add all API env vars in Render dashboard.
- Required production env:
  - `FILMIX_PAGE_URL=https://filmix.zip/multser/detskij/87660-v-schenyachiy-patrul-chas-2013.html`
  - `FILMIX_COOKIE=<cookie from browser request POST /api/movies/player-data>`
  - `FILMIX_PREFERRED_TRANSLATION_PATTERN=ukr|укра`
  - `FIXED_SEASON=5`
  - `FIXED_EPISODE=11`
  - `FIXED_QUALITY=480`
  - `CORS_ORIGIN=https://<github-user>.github.io`
- Keep empty in production:
  - `FIXED_LOCAL_FILE_PATH=`
  - `FIXED_ENGLISH_SOURCE=`
  - `FIXED_PUBLIC_MEDIA_URL=`

## Production rollout

1. Deploy API on Render and verify:

```bash
curl https://<render-domain>/api/health
curl https://<render-domain>/api/fixed-episode
```

2. Set GitHub repository variable:
  - `VITE_API_BASE_URL=https://<render-domain>`
3. Run GitHub Pages workflow `Deploy Pages` on `main` or manually.
4. Verify web URL:
  - `https://<github-user>.github.io/<repo>/`
5. Run remote smoke check.

## Cookie rotation runbook

If playback fails or `/api/fixed-episode` returns an error:

1. Open Filmix in browser with active account.
2. In DevTools Network, find `POST /api/movies/player-data`.
3. Copy full request `Cookie` header.
4. Update Render env `FILMIX_COOKIE`.
5. Restart Render service.
6. Re-run smoke checks.

## Notes

- Keep Filmix credentials only in API environment variables.
- Do not expose Filmix secrets in frontend code or Pages settings.

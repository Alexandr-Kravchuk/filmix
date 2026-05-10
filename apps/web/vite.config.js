import { defineConfig } from 'vite';

function resolveBase() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    return '/';
  }
  const repository = process.env.GITHUB_REPOSITORY || '';
  const parts = repository.split('/');
  const repoName = parts[1] || '';
  if (!repoName) {
    return '/';
  }
  return `/${repoName}/`;
}

function resolveAllowedHosts() {
  const fromEnv = String(process.env.VITE_ALLOWED_HOSTS || '').trim();
  const baseHosts = ['.trycloudflare.com', '.loca.lt', '.ngrok-free.app', '.serveo.net'];
  if (!fromEnv) {
    return baseHosts;
  }
  const extra = fromEnv.split(',').map((entry) => entry.trim()).filter(Boolean);
  return baseHosts.concat(extra);
}

export default defineConfig({
  base: resolveBase(),
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  },
  server: {
    host: true,
    allowedHosts: resolveAllowedHosts()
  }
});

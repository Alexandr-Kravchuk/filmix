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

export default defineConfig({
  base: resolveBase(),
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  }
});

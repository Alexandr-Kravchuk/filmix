import path from 'node:path';
import fs from 'node:fs/promises';
import { buildEpisodeKey } from './types.js';

const filePattern = /^\d+:\d+$/;

export function getDefaultEnglishMapPath() {
  return path.resolve(process.cwd(), 'apps/api/data/english-map.json');
}

export function normalizeEnglishMap(input) {
  const output = {};
  if (!input || typeof input !== 'object') {
    return output;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!filePattern.test(key)) {
      continue;
    }
    if (typeof value !== 'string' || !value.startsWith('http')) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

export async function loadEnglishMap(filePath = getDefaultEnglishMapPath()) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(content);
    return normalizeEnglishMap(data);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function saveEnglishMap(map, filePath = getDefaultEnglishMapPath()) {
  const normalized = normalizeEnglishMap(map);
  const sorted = Object.keys(normalized)
    .sort((a, b) => {
      const [seasonA, episodeA] = a.split(':').map(Number);
      const [seasonB, episodeB] = b.split(':').map(Number);
      if (seasonA !== seasonB) {
        return seasonA - seasonB;
      }
      return episodeA - episodeB;
    })
    .reduce((acc, key) => {
      acc[key] = normalized[key];
      return acc;
    }, {});
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
  return sorted;
}

export function getEnglishSource(map, season, episode) {
  const key = buildEpisodeKey(season, episode);
  return map[key] || null;
}

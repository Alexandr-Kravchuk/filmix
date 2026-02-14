import fs from 'node:fs/promises';
import path from 'node:path';
import { loadEnglishMap, saveEnglishMap } from '../apps/api/src/english-map-service.js';
import { parseHarToEnglishMap } from '../apps/api/src/har-import-service.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === '--input') {
      args.input = argv[i + 1];
      i += 1;
      continue;
    }
    if (current === '--output') {
      args.output = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    process.stderr.write('Usage: node scripts/extract-english-from-har.mjs --input <file.har> [--output <english-map.json>]\n');
    process.exit(1);
  }
  const inputPath = path.resolve(process.cwd(), args.input);
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.resolve(process.cwd(), 'apps/api/data/english-map.json');
  const raw = await fs.readFile(inputPath, 'utf8');
  const harObject = JSON.parse(raw);
  const existingMap = await loadEnglishMap(outputPath);
  const merged = parseHarToEnglishMap(harObject, { existingMap });
  const saved = await saveEnglishMap(merged, outputPath);
  process.stdout.write(`Saved ${Object.keys(saved).length} english entries to ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

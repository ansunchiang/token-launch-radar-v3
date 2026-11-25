import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildDossier } from './vendor/makefun-board.ts';

const sourceFile = fileURLToPath(import.meta.url);
const root = dirname(sourceFile);
const require = createRequire(import.meta.url);
const { buildRadar } = require('./dashboard/model.js');
const { values } = parseArgs({
  options: { input: { type: 'string' }, output: { type: 'string' } }
});
const input = resolve(values.input ?? '/input');
const out = resolve(values.output ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output');
const snapshot = JSON.parse(readFileSync(statSync(input).isDirectory() ? join(input, 'snapshot.json') : input, 'utf8'));
const { board, model } = buildRadar(snapshot);

type Row = { slug: string; rank: number; implied_value_usd: number; farm_steps: string[] };
const rows: Row[] = board.rows;
const ranked = new Set(rows.map(row => row.slug));
const invalid = rows.length < 100 || rows.length > 4000 || ranked.size !== rows.length ||
  snapshot.watchlist.some((slug: string) => !ranked.has(slug)) ||
  rows[0].implied_value_usd === rows[rows.length - 1].implied_value_usd ||
  rows.some((row, i) => row.rank !== i + 1 || !Number.isSafeInteger(row.implied_value_usd) ||
    row.implied_value_usd < 1 || row.implied_value_usd > 1e14 ||
    (i > 0 && row.implied_value_usd > rows[i - 1].implied_value_usd) ||
    row.farm_steps.length < 3 || row.farm_steps.length > 12 ||
    row.farm_steps.some(step => step.trim().length < 20 || step.trim().length > 600));
if (invalid) throw new Error('Board failed rank, coverage, value or farm-step checks.');

const mainSource = readFileSync(sourceFile, 'utf8');
// The browser hashes the same framing after substituting its own rebuilt board.
const payload = JSON.stringify([mainSource, snapshot, board]);
const mainHash = createHash('sha256').update(payload).digest('hex').slice(0, 8);
const provenance = JSON.stringify({ snapshot, board, mainHash, mainSource }).replaceAll('<', '\\u003c');
for (const dir of ['dashboard', 'screenshots']) {
  mkdirSync(join(out, dir), { recursive: true });
  for (const item of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (item.isFile() && !item.name.startsWith('.')) {
      copyFileSync(join(root, dir, item.name), join(out, dir, item.name));
    }
  }
}

writeFileSync(join(out, 'board.json'), JSON.stringify(board) + '\n');
writeFileSync(join(out, 'data.js'), `globalThis.RadarData = ${provenance};\n`);
const dossier = buildDossier(out, {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 4, max_bytes: 59999 }
});
if (dossier.byteLength > 1572864) throw new Error('Dossier exceeds 1.5 MiB.');
const { text } = JSON.parse(Buffer.from(dossier).toString('utf8'));
if (/^\[(?:Cut at|\d+ of this file)/m.test(text)) throw new Error('Dossier source must be complete.');
writeFileSync(join(out, 'dossier.json'), dossier);
console.log(`Built ${rows.length} ranks, ${snapshot.watchlist.length} watchlist slugs and ${model.comps.length} independent priced peers. Checksum ${mainHash}.`);

// run-practice.mjs — self-contained practice-set test for the png-squeeze entry.
// Usage: node run-practice.mjs [KIT_DIR] [ENTRY_DIR]
//   KIT_DIR   default ~/workspace/makefun/kits/png-squeeze-01-run-20261127-kit
//   ENTRY_DIR default ~/workspace/makefun/entry-png-squeeze
// Runs main.ts on practice/input, decodes every output with the kit's own decoder and
// compares pixels to the input, then scores with the kit's scorer against
// practice/reference. Prints per-instance bytes + points + total score + runtime.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const home = os.homedir();
const KIT = process.argv[2] ?? join(home, 'workspace/makefun/kits/png-squeeze-01-run-20261127-kit');
const ENTRY = process.argv[3] ?? join(home, 'workspace/makefun/entry-png-squeeze');
const OUT = join(ENTRY, '.out-practice');
const SCORES = join(ENTRY, '.scores-practice');

const manifest = JSON.parse(readFileSync(join(KIT, 'practice/reference/manifest.json'), 'utf8'));
const keyById = Object.fromEntries(manifest.instances.map((i) => [i.id, i.key]));

// The kit's decoder (program/scorer/checker/png.mjs) — import by file URL
// (a bare Windows path like C:\... is rejected by the ESM loader as scheme 'c:').
const { decodePng } = await import(pathToFileURL(join(KIT, 'program/scorer/checker/png.mjs')).href);

rmSync(OUT, { recursive: true, force: true });
rmSync(SCORES, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(SCORES, { recursive: true });

// 1. Run the entry on the practice set.
const t0 = Date.now();
const run = spawnSync(process.execPath, [join(ENTRY, 'main.ts')], {
  env: { ...process.env, MAKEFUN_INPUT_DIR: join(KIT, 'practice/input'), MAKEFUN_OUTPUT_DIR: OUT },
  encoding: 'utf8',
});
const wallMs = Date.now() - t0;
if (run.status !== 0) {
  console.error('main.ts FAILED (exit ' + run.status + ')');
  console.error(run.stderr);
  process.exit(1);
}

// 2. Independent decode check: every output must decode to the input's exact pixels.
let allExact = true;
const rows = [];
for (const id of Object.keys(keyById).sort()) {
  const key = keyById[id];
  const inPng = decodePng(new Uint8Array(readFileSync(join(KIT, 'practice/input', id, 'image.png'))));
  const outPath = join(OUT, id, 'image.png');
  if (!existsSync(outPath)) { rows.push({ id, key, bytes: 0, exact: false, why: 'missing output' }); allExact = false; continue; }
  const outPng = decodePng(new Uint8Array(readFileSync(outPath)));
  const bytes = statSync(outPath).size;
  let exact = false;
  let why = '';
  if (!outPng.ok) { why = 'unreadable: ' + outPng.why; }
  else if (!inPng.ok) { why = 'input unreadable: ' + inPng.why; }
  else {
    const a = outPng.rgba, b = inPng.rgba;
    let differ = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
    if (differ === 0) exact = true;
    else why = differ + ' bytes differ';
  }
  if (!exact) allExact = false;
  rows.push({ id, key, bytes, exact, why });
}

// 3. Score with the kit's scorer.
const score = spawnSync(process.execPath, [join(KIT, 'program/scorer/score.ts')], {
  env: { ...process.env, MAKEFUN_OUTPUT_DIR: OUT, MAKEFUN_REFERENCE_DIR: join(KIT, 'practice/reference'), MAKEFUN_SCORES_DIR: SCORES },
  encoding: 'utf8',
});
if (score.status !== 0) {
  console.error('scorer FAILED (exit ' + score.status + ')');
  console.error(score.stderr);
  process.exit(1);
}
const scores = JSON.parse(readFileSync(join(SCORES, 'scores.json'), 'utf8'));
const checks = JSON.parse(readFileSync(join(SCORES, 'checks.json'), 'utf8'));
const checkById = Object.fromEntries(checks.map((c) => [c.key, c]));

// 4. Report.
console.log('id    theme  bytes     scale     floor    target    points   exact');
for (const r of rows) {
  const pts = scores[r.id] ?? 0;
  const detail = checkById[r.id]?.detail ?? '';
  console.log(
    r.id, r.key.theme.padEnd(6),
    String(r.bytes).padStart(8), String(r.key.scale_bytes).padStart(8),
    String(r.key.floor_bytes).padStart(8), String(r.key.target_bytes).padStart(8),
    String(pts).padStart(8), r.exact ? 'OK' : 'FAIL ' + (r.why || detail),
  );
}
console.log('---');
console.log('total score:', scores.score, '/ 1000000');
console.log('passed (gate):', scores.passed, '| answered:', scores.answered, '/', scores.instances);
console.log('wall time (whole set):', (wallMs / 1000).toFixed(2), 's (budget 60 s)');
console.log('all pixels exact:', allExact);

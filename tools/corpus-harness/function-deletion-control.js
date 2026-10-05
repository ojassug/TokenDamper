#!/usr/bin/env node
'use strict';

/**
 * R4 step 2 (spec §4.3, DECISIONS §85) — the hand-elided control.
 *
 * Usage:
 *   node tools/corpus-harness/function-deletion-control.js <root> [...] --language c|csharp --out <dir>
 *        [--exclude dir1,dir2]
 *
 * For each file, every named block-bodied declaration is deleted whole — header and body — and the
 * drift gate scores before against after in deep mode. **`S_k` must be non-zero on every file that
 * lost a function.** §59's version of this control on Go is how the step-1 hazard was found: a file
 * with every function deleted scored `S_k = 0.0000` with `astMeasured: true`. The fast-mode score is
 * recorded beside it, because it is the hazard this step closes.
 *
 * Refuses an empty set, and a set in which no file had a function to delete.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSIONS = { c: ['.c', '.h'], csharp: ['.cs'] };

function req(rel, build) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`REFUSED: ${rel} is missing. Build it first: ${build}`);
    process.exit(2);
  }
  return require(abs);
}

function walk(dir, exts, exclude, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '.git' && e.name !== 'node_modules' && !exclude.has(e.name)) walk(p, exts, exclude, out);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valued = new Set(['--language', '--out', '--exclude']);
  const roots = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const language = opt('language');
  const outDir = opt('out');
  const exclude = new Set((opt('exclude') ?? '').split(',').filter(Boolean));
  if (!EXTENSIONS[language] || !outDir || roots.length === 0) {
    console.error('usage: function-deletion-control.js <root> [...] --language c|csharp --out <dir> [--exclude a,b]');
    process.exit(2);
  }

  const { createDeepBackends } = req('packages/deep/dist/index.js', 'npx tsc -p packages/deep/tsconfig.json');
  const { registerParserBackend } = req('dist/src/core/parser/registry.js', 'npm run build');
  const { DriftTracker } = req('dist/src/core/ledger/drift-tracker.js', 'npm run build');
  const { createContextBundle } = req('dist/src/core/model/constructors.js', 'npm run build');

  const backends = await createDeepBackends();
  for (const b of backends) if (b.language !== 'javascript') registerParserBackend(b);
  const backend = backends.find((b) => b.language === language);

  const files = roots.flatMap((r) => walk(path.resolve(r), EXTENSIONS[language], exclude, []));
  if (files.length === 0) {
    console.error('REFUSED: no files selected.');
    process.exit(2);
  }

  const deep = new DriftTracker({ engineMode: 'deep' });
  const fast = new DriftTracker();
  const rows = [];
  const violations = [];
  let withFunctions = 0;
  let witnessed = 0;
  let fastZero = 0;

  for (const abs of files) {
    const content = fs.readFileSync(abs, 'utf8');
    const defs = backend.definitions(content);
    if (defs.length === 0) continue;
    withFunctions += 1;
    // Delete back to front so earlier offsets stay valid; skip a span nested in one already removed.
    let after = content;
    let removedFrom = Infinity;
    for (const d of [...defs].sort((a, b) => b.start - a.start)) {
      if (d.end > removedFrom) continue;
      after = after.slice(0, d.start) + after.slice(d.end);
      removedFrom = d.start;
    }
    // The same path on both sides gives both items the same id, which is how drift pairs them.
    const before = createContextBundle(content, 'file', abs);
    const afterBundle = createContextBundle(after, 'file', abs);
    const d = deep.calculateDrift(before, afterBundle);
    const f = fast.calculateDrift(before, afterBundle);
    const row = {
      file: abs,
      functions: defs.length,
      deepScore: d.driftScore,
      deepMeasured: d.measured,
      fastScore: f.driftScore,
      fastMeasured: f.measured,
    };
    rows.push(row);
    if (d.driftScore > 0) witnessed += 1;
    else violations.push(row);
    if (f.driftScore === 0) fastZero += 1;
  }

  if (withFunctions === 0) {
    console.error('REFUSED: no file had a function to delete. The control examined nothing.');
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const summary = {
    language,
    roots: roots.map((r) => path.resolve(r)),
    files: files.length,
    withFunctions,
    witnessed,
    violations: violations.length,
    // Files where the fast tracker, given the same deletion, scored 0 — the hazard this step closes.
    fastZeroScore: fastZero,
  };
  fs.writeFileSync(path.join(outDir, 'deletion-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'deletion-rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (violations.length > 0) process.exit(1);
}

main();

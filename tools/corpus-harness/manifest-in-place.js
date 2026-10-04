#!/usr/bin/env node
'use strict';

/**
 * Writes a `measure.js` manifest for a checkout **without copying it** (spec §5, DECISIONS §86).
 *
 * Usage:
 *   node tools/corpus-harness/manifest-in-place.js <root> --bucket <name> --ext c,h
 *        [--exclude dir1,dir2] [--min-bytes 1024] [--max-bytes 204800] [--classify]
 *
 * `collect.js` copies a corpus out and flattens its paths, which on Windows breaks deep trees
 * (jellyfin, the Go stdlib) with an ENOENT that does not look like a path-length error. This
 * hashes files where they stand instead, so `measure.js <root>` verifies and runs them in place.
 * Weaker provenance than a `collect.js` pin, and every figure quoted from it says so.
 *
 * `--classify` appends `-source` / `-test` to the bucket using `ceiling.js`'s rule and drops
 * generated files, which is how §82 reported every language (design §3.7).
 */

const fs = require('fs');
const path = require('path');
const { pinEngine, sha256 } = require('./collect.js');
const { classify } = require('./ceiling.js');

const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

function main() {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const root = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
  const bucket = opt('bucket');
  const exts = (opt('ext') ?? '').split(',').filter(Boolean).map((e) => `.${e}`);
  const exclude = new Set((opt('exclude') ?? '').split(',').filter(Boolean));
  const minBytes = Number(opt('min-bytes', '1024'));
  const maxBytes = Number(opt('max-bytes', '204800'));
  const doClassify = argv.includes('--classify');
  if (!root || !bucket || exts.length === 0) {
    console.error('usage: manifest-in-place.js <root> --bucket <name> --ext c,h [--exclude a,b] [--classify]');
    process.exit(2);
  }

  const files = [];
  let generated = 0;
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!ALWAYS_SKIP.has(e.name) && !exclude.has(e.name)) visit(abs);
        continue;
      }
      if (!e.isFile() || !exts.some((x) => e.name.endsWith(x))) continue;
      const buf = fs.readFileSync(abs);
      if (buf.length < minBytes || buf.length > maxBytes) continue;
      const corpusPath = path.relative(root, abs).replace(/\\/g, '/');
      let name = bucket;
      if (doClassify) {
        const cls = classify(corpusPath, buf.toString('utf8'));
        if (cls === 'generated') {
          generated += 1;
          continue;
        }
        name = `${bucket}-${cls}`;
      }
      files.push({ bucket: name, corpusPath, source: abs, bytes: buf.length, sha256: sha256(buf) });
    }
  };
  visit(root);

  if (files.length === 0) {
    console.error('REFUSED: no eligible files. An empty corpus measures nothing and reads like a result.');
    process.exit(2);
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    inPlace: true,
    root: root.replace(/\\/g, '/'),
    engine: pinEngine(),
    machineSpecific: true,
    filters: { exts, exclude: [...exclude], minBytes, maxBytes, classify: doClassify, generatedSkipped: generated },
    totals: { files: files.length },
    files,
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const counts = {};
  for (const f of files) counts[f.bucket] = (counts[f.bucket] ?? 0) + 1;
  console.log(`${files.length} files (generated skipped: ${generated}) -> ${path.join(root, 'manifest.json')}`);
  console.log(counts);
}

main();

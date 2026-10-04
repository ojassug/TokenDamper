#!/usr/bin/env node
'use strict';

/**
 * R4 step 1 (spec §4.2, DECISIONS §84) — a Fast lexer's verdict on every file of a tree, plus the
 * mutation control.
 *
 * Usage:
 *   node tools/corpus-harness/lexer-census.js <root> [<root> ...] --language c|csharp --out <dir>
 *        [--exclude dir1,dir2]
 *
 * **Every flagged file is listed, not only disagreements.** The bar is "every flag read", and a
 * tool that listed only Fast-versus-Deep disagreements would hide a lexer false positive on any
 * file the grammar also rejects — a quarter of real C (§82).
 *
 * Refuses an empty file set (0 flags over 0 files reads like a pass), and refuses a file the Fast
 * chain does not route to the expected validator (design §3.8: assert classification first). The
 * mutation control deletes each file's last `}`-only line and requires the verdict to flip; a file
 * whose verdict does not flip is listed in `missed.jsonl`, to be read and explained.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXTENSIONS = { c: ['.c', '.h'], csharp: ['.cs'] };
const ALWAYS_SKIP = new Set(['.git', 'node_modules']);

function mutateLastCloser(content) {
  const lines = content.split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].replace(/\r$/, '').trim() === '}') {
      lines.splice(k, 1);
      return lines.join('\n');
    }
  }
  return null;
}

function walk(dir, exts, exclude, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!ALWAYS_SKIP.has(e.name) && !exclude.has(e.name)) walk(p, exts, exclude, out);
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) {
      out.push(p);
    }
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const valued = new Set(['--language', '--out', '--exclude']);
  const roots = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]));
  const language = opt('language');
  const outDir = opt('out');
  const exclude = new Set((opt('exclude') ?? '').split(',').filter(Boolean));
  if (!EXTENSIONS[language] || !outDir || roots.length === 0) {
    console.error('usage: lexer-census.js <root> [...] --language c|csharp --out <dir> [--exclude a,b]');
    process.exit(2);
  }

  const distAst = path.join(REPO_ROOT, 'dist', 'src', 'core', 'validation', 'ast', 'index.js');
  if (!fs.existsSync(distAst)) {
    console.error('REFUSED: dist/ is missing. Run `npm run build` first.');
    process.exit(2);
  }
  const { selectValidator } = require(distAst);
  const { createContextItem } = require(path.join(REPO_ROOT, 'dist', 'src', 'core', 'model', 'constructors.js'));

  const files = roots.flatMap((root) => walk(path.resolve(root), EXTENSIONS[language], exclude, []));
  if (files.length === 0) {
    console.error('REFUSED: no files selected. A clean result over an empty set reads like a pass.');
    process.exit(2);
  }

  const treeHash = crypto.createHash('sha256');
  const flaggedRows = [];
  const missedRows = [];
  let bytes = 0;
  let mutable = 0;
  let caught = 0;

  for (const abs of files) {
    const raw = fs.readFileSync(abs);
    bytes += raw.length;
    treeHash.update(abs.replace(/\\/g, '/'));
    treeHash.update(crypto.createHash('sha256').update(raw).digest());
    const content = raw.toString('utf8');
    const item = createContextItem({ id: 'x', kind: 'file', content, contentType: 'code', path: abs });
    const validator = selectValidator(item);
    if (!validator || validator.language !== language) {
      console.error(`REFUSED: ${abs} routes to ${validator ? validator.language : 'no validator'}, not ${language}.`);
      process.exit(2);
    }
    const verdict = validator.validate(content);
    if (!verdict.valid) {
      flaggedRows.push({ file: abs, bytes: raw.length, issues: verdict.issues.slice(0, 3) });
    }
    const mutated = verdict.valid ? mutateLastCloser(content) : null;
    if (mutated !== null) {
      mutable += 1;
      if (validator.validate(mutated).valid) missedRows.push({ file: abs });
      else caught += 1;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const summary = {
    language,
    roots: roots.map((r) => path.resolve(r)),
    exclude: [...exclude],
    files: files.length,
    bytes,
    treeHash: treeHash.digest('hex'),
    flagged: flaggedRows.length,
    flaggedRate: flaggedRows.length / files.length,
    mutation: { mutable, caught, missed: missedRows.length, catchRate: mutable ? caught / mutable : null },
  };
  fs.writeFileSync(path.join(outDir, 'census-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'flagged.jsonl'), flaggedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'missed.jsonl'), missedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { mutateLastCloser, EXTENSIONS };

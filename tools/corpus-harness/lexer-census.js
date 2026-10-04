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

const OPENS_GROUP = /^\s*#\s*(?:if|ifdef|ifndef)\b/;
const CLOSES_GROUP = /^\s*#\s*endif\b/;
const GUARD_TEST = /^\s*#\s*(?:ifndef\s+([A-Za-z_]\w*)|if\s+!\s*defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?)\s*(?:\/\/.*|\/\*.*\*\/)?\s*$/;

/** Whether the group opened at `lines[j]` is an include guard, mirroring `CValidator`. */
function opensIncludeGuard(lines, j) {
  const m = GUARD_TEST.exec(lines[j].replace(/\r$/, ''));
  const macro = m && (m[1] || m[2]);
  if (!macro) return false;
  for (let k = j + 1; k < Math.min(lines.length, j + 9); k++) {
    const text = lines[k].trim();
    if (text === '' || text.startsWith('//') || (text.startsWith('/*') && text.endsWith('*/'))) continue;
    return new RegExp(`^#\\s*define\\s+${macro}(?![A-Za-z0-9_])`).test(text);
  }
  return false;
}

const BRANCHES_GROUP = /^\s*#\s*(elif|elifdef|elifndef|else)\b/;
const IF_LINE = /^\s*#\s*(ifdef|ifndef|if)\b(.*)$/;

function splitTopLevel(expr, op) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < expr.length; k++) {
    if (expr[k] === '(') depth++;
    else if (expr[k] === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, k)) {
      parts.push(expr.slice(start, k));
      start = k + op.length;
      k += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

function stripOuterParens(expr) {
  let e = expr.trim();
  while (e.startsWith('(') && e.endsWith(')')) {
    let depth = 0;
    let enclosesAll = true;
    for (let k = 0; k < e.length - 1; k++) {
      if (e[k] === '(') depth++;
      else if (e[k] === ')') depth--;
      if (depth === 0) {
        enclosesAll = false;
        break;
      }
    }
    if (!enclosesAll) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/** `CValidator.evaluate`, mirrored: the value of a condition in any C build, or null. */
function evaluate(expr, deadOnly) {
  const e = stripOuterParens(expr);
  const disjuncts = splitTopLevel(e, '||');
  if (disjuncts.length > 1) {
    const values = disjuncts.map((d) => evaluate(d, deadOnly));
    if (values.includes(true)) return true;
    return values.every((v) => v === false) ? false : null;
  }
  const conjuncts = splitTopLevel(e, '&&');
  if (conjuncts.length > 1) {
    const values = conjuncts.map((c) => evaluate(c, deadOnly));
    if (values.includes(false)) return false;
    return values.every((v) => v === true) ? true : null;
  }
  if (e.startsWith('!')) {
    const value = evaluate(e.slice(1), deadOnly);
    return value === null ? null : !value;
  }
  if (e === '0') return false;
  if (e === '1') return true;
  const m = /^defined\s*\(?\s*([A-Za-z_]\w*)\s*\)?$/.exec(e);
  const tested = m ? m[1] : /^[A-Za-z_]\w*$/.test(e) ? e : null;
  if (tested === null) return null;
  return tested === '__cplusplus' || deadOnly.has(tested) ? false : null;
}

/** The value of the condition on an `#if`/`#ifdef`/`#ifndef` line in any C build, or null. */
function conditionTruth(line, deadOnly = new Set()) {
  const m = IF_LINE.exec(line.replace(/\r$/, ''));
  if (!m) return null;
  const rest = m[2].replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '').trim();
  if (m[1] === 'ifdef') return evaluate(`defined(${rest})`, deadOnly);
  if (m[1] === 'ifndef') return evaluate(`!defined(${rest})`, deadOnly);
  return evaluate(rest, deadOnly);
}

/**
 * The line the mutation deletes — the last one that is a closing brace alone — and whether it
 * sits where a build configuration can drop it.
 *
 * The second half is what makes a miss explicable rather than merely counted. `CValidator`
 * accepts content that balances under either of two consistent configurations (DECISIONS §84),
 * so a brace can be deleted and leave valid C wherever one configuration drops the line: a
 * known-dead branch (`#ifdef __cplusplus`, `#if 0`), or either side of an `#if`/`#else`. A group
 * with no `#else` is counted by both configurations, and an include guard always is, so a miss
 * there is a real one and the site is code.
 *
 * Directive lines are matched without lexing, outside block comments only; a census tolerates
 * that approximation, because it moves a site between populations rather than hiding it.
 */
function lastCloserSite(content) {
  const lines = content.split('\n');
  // One pass for the block-comment state of every line, and the groups with their branches.
  const commentAt = [];
  const groups = [];
  const open = [];
  const deadOnly = new Set();
  const live = new Set();
  let inComment = false;
  for (let j = 0; j < lines.length; j++) {
    commentAt[j] = inComment;
    const text = lines[j];
    if (!inComment) {
      if (OPENS_GROUP.test(text)) {
        const truth = conditionTruth(text, deadOnly);
        const group = { open: j, end: lines.length, guard: opensIncludeGuard(lines, j), truth, branchStarts: [j], hasElse: false, dead: truth === false };
        groups.push(group);
        open.push(group);
      } else if (BRANCHES_GROUP.test(text) && open.length > 0) {
        const group = open[open.length - 1];
        group.branchStarts.push(j);
        group.dead = group.truth === true;
        if (/^\s*#\s*else\b/.test(text)) group.hasElse = true;
      } else if (CLOSES_GROUP.test(text) && open.length > 0) {
        open.pop().end = j;
      } else {
        const def = /^\s*#\s*(define|undef)\s+([A-Za-z_]\w*)/.exec(text);
        if (def && def[1] === 'undef') {
          live.delete(def[2]);
          deadOnly.delete(def[2]);
        } else if (def && open.some((g) => g.dead)) {
          if (!live.has(def[2])) deadOnly.add(def[2]);
        } else if (def) {
          live.add(def[2]);
          deadOnly.delete(def[2]);
        }
      }
    }
    const lastOpen = text.lastIndexOf('/*');
    const lastClose = text.lastIndexOf('*/');
    if (lastOpen > lastClose) inComment = true;
    else if (lastClose > lastOpen) inComment = false;
  }

  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].replace(/\r$/, '').trim() !== '}') continue;
    // A site is code only when both of `CValidator`'s configurations count its branch; anywhere
    // one of them drops it, deleting the brace can leave content that configuration accepts.
    const droppable = groups.some((g) => {
      if (k <= g.open || k >= g.end) return false;
      const branch = g.branchStarts.filter((start) => start < k).length - 1;
      const branches = g.branchStarts.length;
      const first = g.guard || g.truth === true ? 0 : g.truth === false ? (branches > 1 ? 1 : -1) : 0;
      const last = g.guard || g.truth === true ? 0 : g.hasElse ? branches - 1 : g.truth === false ? (branches > 1 ? 1 : -1) : 0;
      return !(branch === first && branch === last);
    });
    // The line continues a `#define` when the lines above it end in `\` back to a directive.
    let j = k - 1;
    while (j >= 0 && /\\\r?$/.test(lines[j])) j--;
    const inMacro = j < k - 1 && /^\s*#/.test(lines[j + 1]);
    return { index: k, insideConditional: droppable, inMacro, inComment: commentAt[k] };
  }
  return null;
}

/** Why a site is not ordinary code, or null when it is (§84's bar applies to those). */
function siteClass(site) {
  if (site.inMacro) return 'macro';
  if (site.inComment) return 'comment';
  if (site.insideConditional) return 'conditional';
  return 'code';
}

function mutateLastCloser(content) {
  const site = lastCloserSite(content);
  if (site === null) return null;
  const lines = content.split('\n');
  lines.splice(site.index, 1);
  return lines.join('\n');
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
  const sites = {
    code: { mutable: 0, caught: 0 },
    macro: { mutable: 0, caught: 0 },
    comment: { mutable: 0, caught: 0 },
    conditional: { mutable: 0, caught: 0 },
  };

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
    const site = verdict.valid ? lastCloserSite(content) : null;
    if (site !== null) {
      const cls = siteClass(site);
      sites[cls].mutable += 1;
      if (validator.validate(mutateLastCloser(content)).valid) {
        missedRows.push({ file: abs, line: site.index + 1, class: cls, insideConditional: site.insideConditional });
      } else {
        sites[cls].caught += 1;
      }
    }
  }
  const rate = (b) => (b.mutable ? b.caught / b.mutable : null);
  const mutable = Object.values(sites).reduce((n, b) => n + b.mutable, 0);
  const caught = Object.values(sites).reduce((n, b) => n + b.caught, 0);

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
    mutation: {
      mutable,
      caught,
      missed: missedRows.length,
      catchRate: mutable ? caught / mutable : null,
      // Ordinary code that every configuration counts: the §84 bar applies, and every miss is read.
      code: { ...sites.code, catchRate: rate(sites.code) },
      // A `}` on a `#define` continuation line is macro text, which the lexer does not count.
      macro: { ...sites.macro, catchRate: rate(sites.macro) },
      // A `}` inside a block comment is not code.
      comment: { ...sites.comment, catchRate: rate(sites.comment) },
      // Inside a conditional group: deleting it may leave code valid in some configuration.
      conditional: { ...sites.conditional, catchRate: rate(sites.conditional) },
    },
  };
  fs.writeFileSync(path.join(outDir, 'census-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'flagged.jsonl'), flaggedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(outDir, 'missed.jsonl'), missedRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { mutateLastCloser, lastCloserSite, siteClass, EXTENSIONS };

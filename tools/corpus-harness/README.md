# Corpus harness

Freeze a corpus, pin the engine, run both routes, record the trace.

This exists because every reduction figure in this project is measured over files a session
may also be editing, and because two separate measurements have already been wrong in ways
nothing caught: the repo moved under a measurement (CLAUDE.md, Gotchas), and a 4b.3 A/B loop
globbed one directory level and measured 132 of 144 files without noticing
(`docs/phase-4b-lever-disposition.md`, finding 3). [retired]

## Use

```bash
# 1. freeze: copy the corpus out, hash it, pin the engine
node tools/corpus-harness/collect.js <out-dir>

# 2. measure: verify hashes, run the CLI on both routes, dump traces
node tools/corpus-harness/measure.js <out-dir> --variant baseline

# 3. patch dist/, re-measure under another label, diff the two jsonl files
node tools/corpus-harness/measure.js <out-dir> --variant candidate

# timing is a SEPARATE invocation — never folded into the run above
node tools/corpus-harness/timing-run.js <out-dir> --variant baseline
```

`<out-dir>` should be a scratch directory outside the repo. Never point it inside `src/`.

`seam2.js <out-dir>` is a one-off analysis, not part of the loop — it scores candidate
`looksLikeMarkdown` rules against the frozen corpus.

## Elidable ceiling (`ceiling.js`)

How much of a language's code sits inside function bodies elision could take — design §3.7's
step 1, run **before** a language is implemented. DECISIONS §82 is the result and the method.

```bash
# a shipped language: spans from packages/deep, proven equal to core's selectElisionRegions
node tools/corpus-harness/ceiling.js <out-dir>/corpus/typescript --language typescript --parity

# a candidate: its grammar is not installed in this repo, so name the WASM
node tools/corpus-harness/ceiling.js <corpus-root> --language rust --grammar <tree-sitter-rust.wasm> \
  --out rust-crates.json --rows rust-crates.rows.jsonl [--exclude dir,dir] [--ext rs]
```

It walks a directory rather than a manifest — a candidate corpus is a checkout, not a
`collect.js` freeze — and records a hash over every file it read instead. Source, test and
generated files are reported apart, and so is every top-level directory, because one crate of
generated bindings moved the Rust figure by thirty points before anyone looked (§82).

Before it reports a number it refuses unless every node type it names exists in the grammar,
every known-answer fixture passes, and every claimed `{ … }` body is one. Two lower bounds sit
beside the ceiling — regions whose body parsed without an ERROR node, and the ceiling over
error-free files — and an independent brace lexer counts regions whose boundaries it cannot
balance. The pre-registered floor is `FLOOR`; `test/unit/corpus-harness-ceiling.test.ts` pins it.

## Lexer census (`lexer-census.js`)

A Fast lexer's verdict on every file of one or more checkouts, plus a mutation control — the
false-positive census DECISIONS §84 gates C and C# on. It lists **every** flagged file, because
the bar is "every flag read", and refuses a file the Fast chain routes to a different validator.

```bash
node tools/corpus-harness/lexer-census.js <root> [<root> ...] --language c --out <dir> [--exclude deps]
```

## In-place manifests (`manifest-in-place.js`)

Hashes a checkout where it stands and writes `measure.js`'s manifest into it, for trees whose
paths are too deep to flatten on Windows. `--classify` splits source from test and drops generated
files using `ceiling.js`'s rule. Weaker provenance than a `collect.js` pin; say so when quoting it.

```bash
node tools/corpus-harness/manifest-in-place.js <root> --bucket redis --ext c,h --exclude deps --classify
node tools/corpus-harness/measure.js <root> --variant deep --engine-mode deep --routes file
```

## Function-deletion control (`function-deletion-control.js`)

The hand-elided control behind DECISIONS §85. Every named block-bodied declaration in each file is
deleted whole, and the drift gate must score `S_k > 0` in deep mode on every file that lost one;
the fast score is recorded beside it. Needs both builds (`npm run build`, and
`npx tsc -p packages/deep/tsconfig.json`).

```bash
node tools/corpus-harness/function-deletion-control.js <root> [<root> ...] --language c --out <dir> [--exclude deps]
```

## Timing (`timing-run.js`)

Per-file latency. **A separate invocation on purpose** — wall clock is noisy and
machine-dependent, byte-identity is deterministic and is what the rest of this harness exists
to produce. Folding timing into `measure.js` would make a green identity result depend on
machine load.

It reports **three** numbers, because one would be wrong:

| | |
|---|---|
| `cold` | git workspace cache cleared per file — models the **CLI**, a fresh process each time |
| `warm` | cache retained — models the **Gateway** and **MCP**, which are long-lived |
| `fixed` | spawned wall clock minus `cold` — Node boot plus module load |

Measured `cold` p50 **159.1ms** against `warm` p50 **3.8ms** — a **41.48x** ratio, caused by
`globalGitCache` (2000ms TTL). Timing N files in one process and calling the result "per-file
latency" under-reports CLI cost forty-fold. See DECISIONS §76 for the baseline.

It drives the engine **in-process through `runCli`** with captured streams, so the computation
is the CLI’s rather than an approximation of it — the ~151ms of per-process fixed cost would
otherwise swamp any engine difference. That buys resolution and costs a guarantee, so **every
file is also run spawned and the output bytes compared**. One disagreement refuses the whole
report.

### Three things it refuses to report

Each was added because the run that produced it looked fine:

- an **empty sample** — a p95 of `0` over no observations reads as a measurement
- a **coverage gap** between the two routes, rather than comparing the intersection
- a run where **no stage was attributed**. The first baseline run did exactly this on all 292
  files: `timeOnce` read `result.trace` and `runCli` returns an exit code, so the per-stage
  table was empty beside a plausible end-to-end number. The instrument had the failure mode it
  was built to detect.

## What it guarantees

- **The corpus cannot move silently.** `measure.js` re-hashes every file against
  `manifest.json` and refuses to run on a mismatch.
- **The engine is pinned, and a dirty tree is visible.** The manifest records the commit, a
  sha256 over every `dist/**/*.js`, and `dirty: true` when the tree has uncommitted changes.
  A result carrying `dirty: true` is an A/B arm, not a baseline.
- **Counts are asserted, not eyeballed.** Each bucket declares `expect`; collection fails on a
  mismatch. `measure.js` asserts `rows === files × routes`.
- **It measures the shipped CLI.** `measure.js` spawns `dist/src/cli/main.js` rather than
  calling the engine in-process — `84fa00d` is the precedent for what happens when a harness
  builds its own `ContextBundle`.

## What it does not guarantee

The corpus is **machine-specific**. `recipe.json` points at third-party source found on a
developer machine (MSYS2, Git for Windows, a pip install) rather than bytes vendored into this
repo — vendoring GPL/BSD source to measure a classifier is a licensing problem for a
measurement. Two runs on the same machine are comparable; a run on another machine produces a
different manifest, which is visible rather than silent.

Aggregates are **not** directly comparable to the figures in `docs/phase-4b-*.md`: this corpus
applies a 1 KB floor, so the TypeScript bucket holds 56 of the repo's 64 sources.

Deterministic selection is not the same as representative selection. Sort-then-take is
reproducible, and on the first run it filled the entire prose bucket with `.agents/`
scratchpads because they sort first. Check what a bucket actually caught before trusting it.

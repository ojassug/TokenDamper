#!/usr/bin/env node
'use strict';

/**
 * R4, design §3.7 step 1 — the elidable ceiling of a language over a corpus.
 *
 * Usage:
 *   node tools/corpus-harness/ceiling.js <root> --language <lang> [--label <name>]
 *        [--grammar <file.wasm>] [--ext e1,e2] [--out <report.json>] [--rows <rows.jsonl>]
 *        [--parity] [--fixtures-only]
 *
 * **The ceiling** is the share of a corpus's bytes that sit inside function bodies which clear
 * the shipped filters — `dropOverlapping` keeps the outer of a nested pair, then
 * `MIN_REGION_BYTES` and `isSubstantiveRegion` (DECISIONS §56). It is an upper bound on what
 * elision can take, **not a projection of what it will**: TypeScript converts 57.78% into
 * 24.56% achieved at target 0.3, and that conversion embeds TypeScript's own fallback rate,
 * which no candidate has until its symbols and validator exist (§56's ordering).
 *
 * ## Where the candidate spans come from
 *
 * - **Shipped languages** (typescript, python, go) take their spans from `packages/deep`'s
 *   `regionsFromTree` — the code `--engine-mode deep` runs. `--parity` then proves this file's
 *   filter pipeline is core's rather than a re-derivation of it: it registers the deep backends
 *   in-process, calls core's own `selectElisionRegions` on every file, and refuses unless the two
 *   region lists are identical. It also reports the Fast ceiling for the same files.
 * - **Candidates** take their spans from the node table below. That table is this instrument's
 *   own claim about what a function body is in each language, and it is the part most likely to
 *   be wrong (design §9: "regions are the uncertain one"). So before any number is reported it
 *   must pass three checks, and a failure refuses the run rather than annotating it:
 *     1. every node type and field it names exists in the loaded grammar — a misspelled type
 *        matches nothing and would *silently understate* the ceiling, killing a language on a
 *        false negative (the widen-language skill's warning);
 *     2. every known-answer fixture for the language passes — raw/multi-line strings, both
 *        comment forms, a declaration with no body, a nested closure counted once, a brace
 *        inside a string literal;
 *     3. nothing claimed to be a `{ … }` body fails to start with `{` and end with `}`.
 *
 * ## What is reported, and why in these classes
 *
 * Every file is `source`, `test` or `generated`, and each class is reported separately:
 * §3.7 requires test files measured apart (`_test.go` read 92.22% against source's 65.36%),
 * and §56's stdlib figure was pulled ten points by generated tables. Vendored directories are
 * skipped and counted, never silently. Per class: files, bytes, the byte-weighted ceiling, the
 * functions-only ceiling (closures excluded — the policy is recorded rather than decided here),
 * the per-file median, files and bytes with no region, and the share of files that parse with
 * an `ERROR`/`MISSING` node. Per top-level directory too, so an outlier is found rather than
 * averaged — `windows-sys` is not what a coding assistant is pointed at.
 *
 * ## Units
 *
 * "Bytes" are JavaScript string length — UTF-16 code units — because that is the unit core's
 * `MIN_REGION_BYTES` comparison uses (`text.length`), and web-tree-sitter's `startIndex` is in
 * the same unit (verified on non-ASCII input: `startIndex` 24 = `indexOf`, UTF-8 offset 29).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * The floor a candidate must clear to be implemented, **pre-registered 2026-09-23 before any
 * candidate ceiling had been measured** (only the shipped languages had run through this file).
 * Decided by the project owner, not fitted to results: at least 40% of *source* bytes (test and
 * generated excluded) on **each** of the candidate's two corpora, never averaged.
 *
 * 40% sits below every ceiling a shipped language has measured under either instrument — the
 * lowest is Python under Fast, 43.23% on pip 26.2.1 — so it reads as "at least as much material
 * as the weakest language already shipped". It is a floor on material, not a projection of
 * reduction: the conversion from ceiling to achieved embeds a fallback rate the candidate does
 * not have yet (§56), and §3.7 requires that rate be the candidate's own.
 */
const FLOOR = 0.4;

function req(rel) {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(
      `REFUSED: ${rel} is missing. Build it first:\n` +
        (rel.startsWith('packages/deep') ? '  npx tsc -p packages/deep/tsconfig.json' : '  npm run build'),
    );
    process.exit(2);
  }
  return require(abs);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * A refusal after the WASM runtime is up is thrown rather than `process.exit`ed: exiting while
 * web-tree-sitter holds a handle trips a libuv assertion on Windows (`UV_HANDLE_CLOSING`,
 * async.c), which buries the refusal under a crash-shaped line.
 */
class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------
// Language table
// ---------------------------------------------------------------------------------------------

/**
 * `functions` — named function/method/constructor/accessor bodies.
 * `closures`  — anonymous functions. Counted in the ceiling, and additionally reported as the
 *               "functions only" ceiling with them excluded, because TypeScript elides arrow
 *               bodies while Go's scanner skips `func` literals, and a DSL-shaped test file
 *               (RSpec, Kotest, Pest) is almost entirely closures. That is a policy question for
 *               the implementation; this instrument measures both answers.
 * `braceTypes` — node types that are a `{ … }` body; a function whose body is none of these and
 *               has no such child is expression-bodied and has no interior to take.
 * `endStyle`  — (Ruby) node types whose body is `end`-delimited, taken with Python's convention:
 *               first statement to the end of the last body line.
 * `stripAs`   — which of core's `isSubstantiveRegion` strippers answers for the language. Core
 *               has three; a candidate borrows the nearest, and the tree-based cross-check below
 *               reports how often that borrowing disagrees with the grammar.
 *
 * Initializer blocks (Java `static {}`, Kotlin `init {}`, C# static constructors are *methods*
 * and are included) are excluded by policy, matching Fast: `FUNCTION_HEADER` requires a
 * parameter list, and a TypeScript class `static {}` block is not a region today.
 */
const LANGUAGES = {
  typescript: {
    exts: ['ts', 'mts', 'cts'],
    wasm: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
    stripAs: 'typescript',
    shipped: true,
  },
  python: {
    exts: ['py'],
    wasm: 'tree-sitter-python/tree-sitter-python.wasm',
    stripAs: 'python',
    shipped: true,
  },
  go: {
    exts: ['go'],
    wasm: 'tree-sitter-go/tree-sitter-go.wasm',
    stripAs: 'go',
    shipped: true,
  },
  rust: {
    exts: ['rs'],
    wasm: 'tree-sitter-rust/tree-sitter-rust.wasm',
    stripAs: 'typescript',
    functions: ['function_item'],
    closures: ['closure_expression'],
    braceTypes: ['block'],
    commentTypes: ['line_comment', 'block_comment'],
  },
  java: {
    exts: ['java'],
    wasm: 'tree-sitter-java/tree-sitter-java.wasm',
    stripAs: 'typescript',
    functions: ['method_declaration', 'constructor_declaration', 'compact_constructor_declaration'],
    closures: ['lambda_expression'],
    braceTypes: ['block', 'constructor_body'],
    commentTypes: ['line_comment', 'block_comment'],
  },
  csharp: {
    exts: ['cs'],
    wasm: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
    stripAs: 'typescript',
    functions: [
      'method_declaration',
      'constructor_declaration',
      'destructor_declaration',
      'operator_declaration',
      'conversion_operator_declaration',
      'local_function_statement',
      'accessor_declaration',
    ],
    closures: ['lambda_expression', 'anonymous_method_expression'],
    braceTypes: ['block'],
    commentTypes: ['comment'],
  },
  c: {
    exts: ['c', 'h'],
    wasm: 'tree-sitter-c/tree-sitter-c.wasm',
    stripAs: 'typescript',
    functions: ['function_definition'],
    closures: [],
    braceTypes: ['compound_statement'],
    commentTypes: ['comment'],
  },
  cpp: {
    exts: ['cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'h'],
    wasm: 'tree-sitter-cpp/tree-sitter-cpp.wasm',
    stripAs: 'typescript',
    functions: ['function_definition'],
    closures: ['lambda_expression'],
    braceTypes: ['compound_statement'],
    commentTypes: ['comment'],
  },
  php: {
    exts: ['php'],
    wasm: 'tree-sitter-php/tree-sitter-php.wasm',
    stripAs: 'typescript',
    functions: ['function_definition', 'method_declaration'],
    closures: ['anonymous_function'],
    braceTypes: ['compound_statement'],
    commentTypes: ['comment'],
  },
  ruby: {
    exts: ['rb'],
    wasm: 'tree-sitter-ruby/tree-sitter-ruby.wasm',
    stripAs: 'python',
    functions: ['method', 'singleton_method'],
    closures: ['do_block', 'block'],
    braceTypes: [],
    endStyle: ['method', 'singleton_method', 'do_block'],
    commentTypes: ['comment'],
  },
  kotlin: {
    exts: ['kt', 'kts'],
    wasm: '@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm',
    stripAs: 'typescript',
    // This grammar names no fields at all (node-types.json: `function_declaration` has only
    // `name`); bodies are found by child type instead. Check 1 caught the assumption.
    bodyField: null,
    functions: ['function_declaration', 'secondary_constructor', 'getter', 'setter'],
    closures: ['anonymous_function', 'lambda_literal'],
    braceTypes: ['function_body', 'block'],
    commentTypes: ['line_comment', 'block_comment'],
  },
};

// ---------------------------------------------------------------------------------------------
// Known-answer fixtures. Each `expect` is the exact list of region texts, in order, that the
// instrument must return with the size floor disabled (a fixture body is small by design) and
// the substantive filter on. Bodies are spliced in by construction, so an expectation cannot
// drift from its source.
// ---------------------------------------------------------------------------------------------

function fx(name, parts) {
  // parts: array of strings and {body: '...'}; region bodies are collected in order.
  let src = '';
  const expect = [];
  for (const part of parts) {
    if (typeof part === 'string') src += part;
    else {
      src += part.body;
      if (!part.nested) expect.push(part.body);
    }
  }
  return { name, src, expect, fnOnly: parts.filter((p) => typeof p !== 'string' && !p.nested && !p.closure).map((p) => p.body) };
}

const FIXTURES = {
  rust: [
    fx('braces in strings, raw strings and both comment forms', [
      'fn render(x: u32) -> String {',
      { body: '\n    // a { in a line comment\n    /* and } in a block */\n    let s = "}{";\n    let r = r#"{"raw}"#;\n    format!("{}{}{}", s, r, x)\n' },
      '}\n',
    ]),
    fx('trait: a signature has no body, a default method does', [
      'trait Shape {\n    fn area(&self) -> f64;\n    fn describe(&self) -> String {',
      { body: '\n        format!("{}", self.area())\n    ' },
      '}\n}\n',
    ]),
    fx('impl methods are regions, the impl body is not', [
      'struct P { x: i32 }\nimpl P {\n    fn get(&self) -> i32 {',
      { body: ' self.x ' },
      '}\n    fn set(&mut self, v: i32) {',
      { body: ' self.x = v; ' },
      '}\n}\n',
    ]),
    fx('a nested closure is counted once, inside its function', [
      'fn outer(v: Vec<i32>) -> i32 {',
      { body: '\n    let f = |x: i32| { x + 1 };\n    v.into_iter().map(f).sum()\n' },
      '}\n',
    ]),
    fx('extern block, const table and macro_rules are not functions', [
      'extern "C" { fn abs(x: i32) -> i32; }\nconst T: [u8; 3] = [1, 2, 3];\nmacro_rules! m { ($x:expr) => { $x + 1 }; }\n',
    ]),
    fx('a comment-only body is not substantive', ['fn noop() {\n    // nothing { here }\n}\n']),
    fx('a closure in a static initializer is a closure region', [
      'static F: fn(i32) -> i32 = |x| {',
      { body: ' x * 2 ', closure: true },
      '};\n',
    ]),
  ],
  java: [
    fx('braces in strings, a text block and both comment forms', [
      'class A {\n    int f(int x) {',
      { body: '\n        // a { brace\n        /* } */\n        String s = "}{";\n        String t = """\n            {"k": 1}\n            """;\n        return s.length() + t.length() + x;\n    ' },
      '}\n}\n',
    ]),
    fx('interface: abstract method has no body, default method does', [
      'interface I {\n    void a();\n    default int b() {',
      { body: ' return 1; ' },
      '}\n}\n',
    ]),
    fx('abstract method and static initializer are not regions', [
      'abstract class C {\n    abstract void m();\n    static { System.out.println("init"); }\n}\n',
    ]),
    fx('constructor body and a nested lambda counted once', [
      'class P {\n    P(int x) {',
      { body: '\n        Runnable r = () -> { go(x); };\n        r.run();\n    ' },
      '}\n}\n',
    ]),
    fx('a lambda in a field initializer is a closure region', [
      'class F {\n    Runnable r = () -> {',
      { body: ' System.out.println("x"); ', closure: true },
      '};\n    java.util.function.IntUnaryOperator g = x -> x + 1;\n}\n',
    ]),
    fx('record compact constructor and enum method', [
      'record R(int x) {\n    R {',
      { body: ' if (x < 0) throw new IllegalArgumentException(); ' },
      '}\n}\nenum E {\n    A;\n    int f() {',
      { body: ' return 2; ' },
      '}\n}\n',
    ]),
  ],
  csharp: [
    fx('verbatim, interpolated and raw strings with braces', [
      'class A {\n    int F(int x) {',
      { body: '\n        // { comment\n        var a = @"}{";\n        var b = $"{x}}}";\n        var c = """\n            {"k": 1}\n            """;\n        return a.Length + b.Length + c.Length;\n    ' },
      '}\n}\n',
    ]),
    fx('expression-bodied members and auto-properties have no interior', [
      'class B {\n    int G(int x) => x + 1;\n    int Q { get; set; }\n    int R => 3;\n}\n',
    ]),
    fx('accessor bodies are regions', [
      'class C {\n    int _p;\n    int P {\n        get {',
      { body: ' return _p; ' },
      '}\n        set {',
      { body: ' _p = value; ' },
      '}\n    }\n}\n',
    ]),
    fx('interface method has no body; constructor and local function', [
      'interface I { void M(); }\nclass D {\n    D(int x) {',
      { body: '\n        int Twice(int y) { return y * 2; }\n        _ = Twice(x);\n    ' },
      '}\n}\n',
    ]),
    fx('a block lambda in a field initializer is a closure region', [
      'class E {\n    System.Func<int, int> f = x => {',
      { body: ' return x + 1; ', closure: true },
      '};\n}\n',
    ]),
  ],
  c: [
    fx('braces in strings, char literals and comments', [
      'int f(int x) {',
      { body: "\n    /* { */\n    char c = '{';\n    const char *s = \"}\";\n    // }\n    return x + c + s[0];\n" },
      '}\n',
    ]),
    fx('prototype, struct and brace-bearing macro are not functions', [
      'int g(int);\nstruct P { int x; };\n#define M(x) { x; }\n',
    ]),
    fx('a function inside #ifdef is still a function', [
      '#ifdef X\nint h(void) {',
      { body: ' return 1; ' },
      '}\n#endif\n',
    ]),
  ],
  cpp: [
    fx('raw string with braces', [
      'int f() {',
      { body: '\n    const char *s = R"({"k": "}"})";\n    return s[0];\n' },
      '}\n',
    ]),
    fx('inline method, declaration-only method, out-of-line definition', [
      'class A {\n  int m() {',
      { body: ' return 1; ' },
      '}\n  int n();\n  A() = default;\n};\nint A::n() {',
      { body: ' return 2; ' },
      '}\n',
    ]),
    fx('template function inside a namespace; lambda nested once', [
      'namespace ns {\ntemplate <typename T> T id(T x) {',
      { body: '\n  auto g = [](T y) { return y; };\n  return g(x);\n' },
      '}\n}\n',
    ]),
    fx('a lambda in a variable initializer is a closure region', [
      'auto h = [](int x) {',
      { body: ' return x * 2; ', closure: true },
      '};\n',
    ]),
    fx('declarations, defaulted members, class and namespace bodies are not regions', [
      'class A {\n  int n();\n  A() = default;\n  A(const A&) = delete;\n};\nnamespace ns { struct S { int x; }; }\nint g(int);\n',
    ]),
  ],
  php: [
    fx('strings, heredoc and both comment forms', [
      '<?php\nfunction f($x) {',
      { body: "\n    // {\n    # }\n    /* { */\n    $a = \"}{\";\n    $b = '{';\n    $c = <<<EOT\n    {$x} }\n    EOT;\n    return $a . $b . $c;\n" },
      '}\n',
    ]),
    fx('abstract and interface methods have no body', [
      '<?php\nabstract class A {\n    abstract function a();\n    public function b() {',
      { body: ' return 1; ' },
      '}\n}\ninterface I { function c(); }\n',
    ]),
    fx('closure is a closure region; arrow fn has no interior', [
      '<?php\n$f = function ($x) use ($y) {',
      { body: ' return $x + $y; ', closure: true },
      '};\n$g = fn($x) => $x + 1;\n',
    ]),
    fx('HTML outside the PHP tags is not code', [
      '<div>{ }</div>\n<?php function h() {',
      { body: ' return 1; ' },
      '} ?>\n<p>}</p>\n',
    ]),
    fx('interface, abstract method, arrow fn and class constants are not regions', [
      '<?php\ninterface I { function c(); }\nabstract class A { const K = [1, 2]; abstract function a(); }\n$g = fn($x) => $x + 1;\n?>\n<div>{ }</div>\n',
    ]),
  ],
  ruby: [
    fx('def body with Python convention: first statement to end of last line', [
      'def add(a, b)\n  ',
      { body: 'a + b' },
      '\nend\n',
    ]),
    fx('braces inside strings, %q and a heredoc', [
      'def render(x)\n  ',
      { body: 's = "}{"\n  t = %q{ {x} }\n  u = <<~EOS\n    { #{x} }\n  EOS\n  s + t + u' },
      '\nend\n',
    ]),
    fx('endless method has no body; singleton method does', [
      'def sq(x) = x * x\ndef self.build\n  ',
      { body: 'new' },
      '\nend\n',
    ]),
    fx('a top-level do block is a closure region, nested ones are subsumed', [
      'describe "x" do\n  ',
      { body: 'it "y" do\n    expect(1).to eq(1)\n  end', closure: true },
      '\nend\n',
    ]),
    fx('a multi-line brace block takes its body, not its parameters', [
      'items.map { |x|\n  ',
      { body: 'x * 2', closure: true },
      '\n}\n',
    ]),
    fx('class body is not a region; rescue stays inside the method body', [
      'class A\n  def m\n    ',
      { body: 'risky\n  rescue => e\n    log(e)' },
      '\n  end\nend\n',
    ]),
    fx('a comment-only method is not substantive', ['def noop\n  # nothing { here }\nend\n']),
  ],
  kotlin: [
    fx('strings, templates and raw strings with braces', [
      'fun render(x: Int): String {',
      { body: '\n    // {\n    /* } */\n    val s = "}{"\n    val t = """{"k": ${x}}"""\n    return s + t\n' },
      '}\n',
    ]),
    fx('expression-bodied function has no interior; abstract has no body', [
      'fun sq(x: Int) = x * x\nabstract class A {\n    abstract fun m(): Int\n    fun n(): Int {',
      { body: ' return 1 ' },
      '}\n}\n',
    ]),
    fx('secondary constructor and accessor bodies', [
      'class P(val x: Int) {\n    constructor() : this(0) {',
      { body: ' println("p") ' },
      '}\n    val y: Int\n        get() {',
      { body: ' return x * 2 ' },
      '}\n}\n',
    ]),
    fx('a top-level lambda takes its statements, not its parameters', [
      'val f = { x: Int ->',
      { body: '\n    x * 2\n', closure: true },
      '}\n',
    ]),
    fx('a nested lambda is counted once; init block is not a region', [
      'class Q {\n    init { println("q") }\n    fun run(xs: List<Int>): Int {',
      { body: '\n        return xs.map { it + 1 }.sum()\n    ' },
      '}\n}\n',
    ]),
    // Multi-line on purpose: @tree-sitter-grammars/tree-sitter-kotlin@1.1.0 rejects a one-line
    // class body (`interface I { fun m(): Int }` parses with MISSING `_class_member_semi`), which
    // is valid Kotlin. A grammar defect, recorded in §82 because Deep's `check()` would flag it.
    fx('expression bodies, interface and abstract members, init blocks are not regions', [
      'fun sq(x: Int) = x * x\ninterface I {\n    fun m(): Int\n}\nabstract class A {\n    abstract fun n(): Int\n}\nclass B {\n    init { println("b") }\n}\ndata class D(val x: Int)\n',
    ]),
  ],
};

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

const VENDOR_DIRS = new Set([
  'vendor', 'third_party', 'third-party', 'thirdparty', 'external', 'deps', 'node_modules',
  '.git', 'target', 'build', 'bin', 'obj', '.gradle', 'pods',
]);

// `[^/]*tests` catches the Rust stdlib's `alloctests`/`coretests`; `testlib`/`testFixtures` are
// Guava's and Gradle's test-support trees.
const TEST_DIR = /(^|\/)(tests?|specs?|__tests__|testing|testdata|test[-_]?suite|unit[-_]?tests?|integration[-_]?tests?|bench|benches|benchmarks?|fixtures?|testfixtures|[^/]*testlib|[^/]*[._-](tests?|specs?)|[^/]*tests)(\/|$)/i;
// A directory *ending* in a capitalised `Test`/`Tests` — Kotlin/Gradle source sets (`jvmTest`,
// `commonTest`), .NET test projects (`Newtonsoft.Json.FuzzTests`). Case-sensitive on purpose:
// under `/i` this pattern matches `latest/`.
const TEST_SOURCE_SET = /(^|\/)[^/]*Tests?(\/|$)/;
const TEST_FILE = /(^|\/)(test_[^/]*|[^/]*[._-](test|tests|spec|specs|unittest)\.[a-z0-9]+|[^/]*(Test|Tests|Spec|Specs|TestCase|[a-z0-9]IT)\.[A-Za-z0-9]+)$/;
// `DO NOT MODIFY` and `automatically generated` are stdarch's header for its generated
// intrinsics; `DO NOT EDIT` alone would read those as hand-written source.
const GENERATED_HEAD = /(@generated|DO NOT (?:EDIT|MODIFY)|<auto-generated|\bauto-?generated\b|automatically generated|Code generated by|generated by the protocol buffer compiler|This file (?:was|is) (?:automatically )?generated)/i;
const GENERATED_NAME = /(\.designer\.cs|\.g\.cs|\.g\.i\.cs|\.pb\.go|_pb2\.py|\.pb\.(?:cc|h)|_generated\.[a-z]+)$/i;

function classify(relPath, content) {
  if (GENERATED_NAME.test(relPath) || GENERATED_HEAD.test(content.slice(0, 4096))) return 'generated';
  if (TEST_DIR.test(relPath) || TEST_SOURCE_SET.test(relPath) || TEST_FILE.test(relPath)) return 'test';
  return 'source';
}

function walkCorpus(root, exts, excludes = []) {
  const files = [];
  const vendored = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const relDir = path.relative(root, full).replace(/\\/g, '/');
        // `--exclude` names corpus-specific vendored trees that carry no conventional name —
        // bitcoin's `src/leveldb` subtree, WordPress's bundled libraries. Counted, never silent.
        if (VENDOR_DIRS.has(entry.name.toLowerCase()) || excludes.includes(relDir)) {
          const rel = path.relative(root, full).replace(/\\/g, '/');
          vendored.set(rel, (vendored.get(rel) ?? 0) + 1);
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
        if (exts.includes(ext)) files.push(full);
      }
    }
  })(root);
  files.sort();
  return { files, vendored: [...vendored.keys()].sort() };
}

// ---------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------

/** Core's `dropOverlapping`, which is private to `regions.ts`. `--parity` proves this copy. */
function dropOverlapping(regions) {
  const sorted = [...regions].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let cursor = -1;
  for (const region of sorted) {
    if (region.start < cursor) continue;
    kept.push(region);
    cursor = region.end;
  }
  return kept;
}

function endOfLineContaining(content, index) {
  const nl = content.indexOf('\n', index);
  return nl === -1 ? content.length : nl;
}

/**
 * The interior of a `{ … }` body belonging to `fn`, or null when it is expression-bodied or
 * bodyless. Throws when something the table calls a brace body is not one — check 3.
 */
function braceInterior(fn, spec, content) {
  let body = spec.bodyField === null ? null : fn.childForFieldName(spec.bodyField ?? 'body');
  if (!body) body = fn.namedChildren.find((c) => spec.braceTypes.includes(c.type)) ?? null;

  const isBracePair = (n) => content[n.startIndex] === '{' && content[n.endIndex - 1] === '}';

  if (body && !isBracePair(body)) {
    // Kotlin's `function_body` wraps the block, or holds `= expr`; a lambda body may be an
    // expression. Look one level down for a brace pair before concluding there is none.
    const inner = body.namedChildren.find((c) => spec.braceTypes.includes(c.type) && isBracePair(c));
    body = inner ?? (spec.braceTypes.includes(body.type) && content[body.startIndex] !== '=' ? body : null);
    if (body && !isBracePair(body)) {
      throw new Error(`check 3: ${fn.type} body ${body.type} at ${body.startIndex} is not a { … } pair`);
    }
  }

  if (!body) {
    // Braces as direct anonymous children of the function node (Kotlin lambda_literal,
    // secondary_constructor in some grammar versions).
    const kids = fn.children;
    const open = kids.find((c) => c.type === '{');
    const close = [...kids].reverse().find((c) => c.type === '}');
    if (!open || !close || close.startIndex <= open.endIndex) return null;
    let start = open.endIndex;
    // A lambda's parameters sit inside its braces (`{ x -> … }`): start after the arrow.
    const arrow = kids.find((c) => c.type === '->' && c.startIndex > open.startIndex && c.endIndex <= close.startIndex);
    if (arrow) start = arrow.endIndex;
    return close.startIndex > start ? { start, end: close.startIndex, body: fn } : null;
  }

  const start = body.startIndex + 1;
  const end = body.endIndex - 1;
  return end > start ? { start, end, body } : null;
}

/**
 * Ruby: `end`-delimited bodies with Python's convention, brace blocks by their body node.
 *
 * The body must be a `body_statement` (or a brace block's `block_body`). The grammar also puts an
 * *expression* in `method.body` for an endless method (`def sq(x) = x * x`, types `_arg` and
 * `rescue_modifier`) — expression-bodied, so no interior, exactly like C#'s `=> x`. Taking it was
 * the first fixture failure this table produced.
 */
function rubyInterior(fn, content) {
  const body = fn.childForFieldName('body');
  if (!body) return null;
  if (fn.type === 'block') {
    if (body.type !== 'block_body') return null;
    return body.endIndex > body.startIndex ? { start: body.startIndex, end: body.endIndex, body } : null;
  }
  if (body.type !== 'body_statement') return null;
  const endKeyword = [...fn.children].reverse().find((c) => c.type === 'end');
  let end = endOfLineContaining(content, body.endIndex - 1);
  if (endKeyword && endKeyword.startIndex < end) end = body.endIndex;
  return end > body.startIndex ? { start: body.startIndex, end, body } : null;
}

/**
 * Whether a C-family body interior is brace-balanced under a lexer that shares nothing with the
 * grammar — comments, string and char literals, C++ raw strings, C# verbatim strings. A boundary
 * the grammar got wrong usually shows up here as an unbalanced interior, so this is reported as
 * an independent check on region boundaries, most useful exactly where the grammar left ERROR or
 * MISSING nodes. Not a refusal: a macro can legitimately carry an unmatched brace.
 */
function lexBalanced(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 1;
      continue;
    }
    if (c === 'R' && text[i + 1] === '"') {
      const open = text.indexOf('(', i + 2);
      const delim = open > 0 ? text.slice(i + 2, open) : '';
      const close = open > 0 ? text.indexOf(`)${delim}"`, open) : -1;
      if (close > 0 && delim.length < 17 && !/[\s\\()]/.test(delim)) {
        i = close + delim.length + 1;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const verbatim = c === '"' && text[i - 1] === '@';
      i++;
      while (i < text.length) {
        if (verbatim) {
          if (text[i] === '"' && text[i + 1] === '"') {
            i += 2;
            continue;
          }
          if (text[i] === '"') break;
          i++;
          continue;
        }
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === c || text[i] === '\n') break;
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

/** Languages whose bodies the C-family lexer above can read. */
const LEXABLE = new Set(['c', 'cpp', 'csharp', 'java']);

/** Whether a region holds anything the grammar calls a statement rather than a comment. */
function treeSubstantive(tree, spec, region) {
  const inside = tree.rootNode.descendantForIndex(region.start, Math.max(region.start, region.end - 1));
  // Walk the smallest node covering the region; any named, non-comment node that lies inside
  // the region is substance.
  const stack = [inside];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.startIndex >= region.start && node.endIndex <= region.end && node.isNamed && !spec.commentTypes.includes(node.type)) {
      return true;
    }
    for (const child of node.namedChildren) {
      if (child.endIndex > region.start && child.startIndex < region.end) stack.push(child);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

async function loadRuntime(language, grammarOverride) {
  const spec = LANGUAGES[language];
  if (!spec) {
    console.error(`REFUSED: unknown --language ${language}. Known: ${Object.keys(LANGUAGES).join(', ')}`);
    process.exit(2);
  }
  const { Parser, Language } = require(require.resolve('web-tree-sitter', { paths: [REPO_ROOT] }));
  await Parser.init();

  let wasmPath = grammarOverride;
  if (!wasmPath) {
    try {
      wasmPath = require.resolve(spec.wasm, { paths: [REPO_ROOT] });
    } catch {
      console.error(`REFUSED: no grammar for ${language}. Pass --grammar <file.wasm> (looked for ${spec.wasm}).`);
      process.exit(2);
    }
  }
  const grammar = await Language.load(wasmPath);
  const parser = new Parser();
  parser.setLanguage(grammar);

  // Check 1: every node type and field the table names exists in this grammar.
  if (!spec.shipped) {
    const missing = [];
    for (const type of [...spec.functions, ...spec.closures, ...spec.braceTypes, ...(spec.endStyle ?? []), ...spec.commentTypes]) {
      if (grammar.idForNodeType(type, true) === null) missing.push(type);
    }
    if (spec.bodyField !== null && grammar.fieldIdForName(spec.bodyField ?? 'body') === null) {
      missing.push(`field:${spec.bodyField ?? 'body'}`);
    }
    if (missing.length > 0) {
      throw new Refusal(`REFUSED (check 1): the ${language} grammar has no node type(s): ${missing.join(', ')}`);
    }
  }

  return { spec, parser, grammar, wasmPath };
}

function candidateRegions(tree, content, language, spec, deepRegions) {
  if (spec.shipped) {
    return { all: deepRegions.regionsFromTree(tree, language, {}), fnOnly: null };
  }
  const all = [];
  const fnOnly = [];
  const types = [...spec.functions, ...spec.closures];
  for (const node of tree.rootNode.descendantsOfType(types)) {
    const region =
      spec.endStyle && (spec.endStyle.includes(node.type) || node.type === 'block')
        ? rubyInterior(node, content)
        : braceInterior(node, spec, content);
    if (!region) continue;
    // `clean`: the *body* node holds no ERROR/MISSING node. A region inside a mis-parsed body is
    // a boundary nobody can vouch for, so the clean-only ceiling is a lower bound beside the full
    // one. The body, not the function: the first version tested the whole function and put
    // abseil at 10.3%, but its dominant errors are annotation macros in the *signature*
    // (`ABSL_ATTRIBUTE_LIFETIME_BOUND`, bitcoin's `NO_THREAD_SAFETY_ANALYSIS`) that leave the body
    // intact — 1,050 of 1,085 such bodies are brace-balanced under an independent lexer.
    const tagged = { start: region.start, end: region.end, clean: !region.body.hasError };
    all.push(tagged);
    if (spec.functions.includes(node.type)) fnOnly.push(tagged);
  }
  return { all, fnOnly };
}

function filterRegions(content, regions, stripAs, core, minBytes) {
  const counts = { small: 0, insubstantive: 0 };
  const kept = dropOverlapping(regions).filter((region) => {
    const text = content.slice(region.start, region.end);
    if (text.length < minBytes) {
      counts.small += 1;
      return false;
    }
    if (!core.isSubstantiveRegion(text, stripAs)) {
      counts.insubstantive += 1;
      return false;
    }
    return true;
  });
  return { kept, counts };
}

/** Rust only: bytes inside `#[cfg(test)] mod … { }` — tests living in source files. */
function rustInlineTestSpans(tree) {
  const spans = [];
  for (const mod of tree.rootNode.descendantsOfType('mod_item')) {
    let sibling = mod.previousNamedSibling;
    while (sibling && sibling.type === 'attribute_item') {
      if (/cfg\s*\(\s*test\s*\)/.test(sibling.text)) {
        spans.push({ start: mod.startIndex, end: mod.endIndex });
        break;
      }
      sibling = sibling.previousNamedSibling;
    }
  }
  return dropOverlapping(spans);
}

function overlapBytes(regions, spans) {
  let total = 0;
  for (const r of regions) {
    for (const s of spans) {
      const lo = Math.max(r.start, s.start);
      const hi = Math.min(r.end, s.end);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

function runFixtures(language, runtime, core, deepRegions) {
  const cases = FIXTURES[language] ?? [];
  const failures = [];
  for (const fixture of cases) {
    const tree = runtime.parser.parse(fixture.src);
    try {
      const { all, fnOnly } = candidateRegions(tree, fixture.src, language, runtime.spec, deepRegions);
      const got = filterRegions(fixture.src, all, runtime.spec.stripAs, core, 0).kept.map((r) => fixture.src.slice(r.start, r.end));
      const gotFn = filterRegions(fixture.src, fnOnly ?? [], runtime.spec.stripAs, core, 0).kept.map((r) => fixture.src.slice(r.start, r.end));
      const ok = JSON.stringify(got) === JSON.stringify(fixture.expect) && JSON.stringify(gotFn) === JSON.stringify(fixture.fnOnly);
      const parseError = tree.rootNode.hasError;
      if (!ok || parseError) {
        failures.push({ name: fixture.name, parseError, expect: fixture.expect, got, expectFnOnly: fixture.fnOnly, gotFnOnly: gotFn });
      }
    } catch (err) {
      failures.push({ name: fixture.name, error: err.message });
    } finally {
      tree.delete();
    }
  }
  return { total: cases.length, failures };
}

function pinEngine() {
  const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const hashDir = (dir) => {
    if (!fs.existsSync(dir)) return null;
    const files = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f.endsWith('.js')) files.push(f);
      }
    })(dir);
    files.sort();
    const h = crypto.createHash('sha256');
    for (const f of files) {
      h.update(path.relative(dir, f).replace(/\\/g, '/'));
      h.update(fs.readFileSync(f));
    }
    return h.digest('hex');
  };
  const porcelain = git(['status', '--porcelain']);
  return {
    commit: git(['rev-parse', 'HEAD']),
    dirty: porcelain.length > 0,
    distHash: hashDir(path.join(REPO_ROOT, 'dist')),
    deepDistHash: hashDir(path.join(REPO_ROOT, 'packages', 'deep', 'dist')),
  };
}

function grammarPin(wasmPath) {
  let pkg = null;
  for (let dir = path.dirname(wasmPath); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json');
    if (fs.existsSync(candidate)) {
      const json = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      pkg = `${json.name}@${json.version}`;
      break;
    }
  }
  return { wasm: wasmPath.replace(/\\/g, '/'), sha256: sha256(fs.readFileSync(wasmPath)), package: pkg };
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function aggregate(rows) {
  const bytes = rows.reduce((n, r) => n + r.bytes, 0);
  const regionBytes = rows.reduce((n, r) => n + r.regionBytes, 0);
  const fnRows = rows.filter((r) => r.fnRegionBytes !== null);
  const fnRegionBytes = fnRows.reduce((n, r) => n + r.fnRegionBytes, 0);
  const noRegion = rows.filter((r) => r.regionBytes === 0);
  const errorFree = rows.filter((r) => !r.parseError);
  const errorFreeBytes = errorFree.reduce((n, r) => n + r.bytes, 0);
  return {
    files: rows.length,
    bytes,
    ceiling: bytes ? regionBytes / bytes : null,
    // Two lower bounds for grammars that mis-parse: regions whose function parsed cleanly, over
    // all bytes; and the plain ceiling over only the files with no ERROR/MISSING node at all.
    ceilingCleanRegions: rows.every((r) => r.cleanRegionBytes !== null) && bytes ? rows.reduce((n, r) => n + r.cleanRegionBytes, 0) / bytes : null,
    ceilingErrorFreeFiles: errorFreeBytes ? errorFree.reduce((n, r) => n + r.regionBytes, 0) / errorFreeBytes : null,
    ceilingFunctionsOnly: fnRows.length === rows.length && bytes ? fnRegionBytes / bytes : null,
    medianFileCeiling: median(rows.filter((r) => r.bytes > 0).map((r) => r.regionBytes / r.bytes)),
    noRegionFiles: rows.length ? noRegion.length / rows.length : null,
    noRegionBytes: bytes ? noRegion.reduce((n, r) => n + r.bytes, 0) / bytes : null,
    parseErrorFiles: rows.length ? rows.filter((r) => r.parseError).length / rows.length : null,
    regions: rows.reduce((n, r) => n + r.regions, 0),
    droppedSmall: rows.reduce((n, r) => n + r.droppedSmall, 0),
    droppedInsubstantive: rows.reduce((n, r) => n + r.droppedInsubstantive, 0),
    stripperTreeDisagreements: rows.reduce((n, r) => n + r.stripperTreeDisagreements, 0),
    unbalancedRegions: rows.every((r) => r.unbalancedRegions !== null) ? rows.reduce((n, r) => n + r.unbalancedRegions, 0) : null,
    ...(rows.some((r) => r.inlineTestBytes !== undefined)
      ? {
          inlineTestBytes: rows.reduce((n, r) => n + (r.inlineTestBytes ?? 0), 0),
          ceilingExcludingInlineTests: (() => {
            const b = bytes - rows.reduce((n, r) => n + (r.inlineTestBytes ?? 0), 0);
            const rb = regionBytes - rows.reduce((n, r) => n + (r.inlineTestRegionBytes ?? 0), 0);
            return b ? rb / b : null;
          })(),
        }
      : {}),
    ...(rows.some((r) => r.fastRegionBytes !== undefined)
      ? { fastCeiling: bytes ? rows.reduce((n, r) => n + (r.fastRegionBytes ?? 0), 0) / bytes : null }
      : {}),
  };
}

function pct(x) {
  return x === null || x === undefined ? '     -' : `${(x * 100).toFixed(2).padStart(6)}%`;
}

async function main() {
  const argv = process.argv.slice(2);
  const opts = { root: null, language: null, label: null, grammar: null, ext: null, out: null, rows: null, parity: false, fixturesOnly: false, exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--language') opts.language = argv[++i];
    else if (a === '--exclude') opts.exclude = argv[++i].split(',').map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--grammar') opts.grammar = argv[++i];
    else if (a === '--ext') opts.ext = argv[++i].split(',');
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--rows') opts.rows = argv[++i];
    else if (a === '--parity') opts.parity = true;
    else if (a === '--fixtures-only') opts.fixturesOnly = true;
    else if (!opts.root) opts.root = a;
    else {
      console.error(`unexpected argument ${a}`);
      process.exit(2);
    }
  }
  if (!opts.language || (!opts.root && !opts.fixturesOnly)) {
    console.error('usage: ceiling.js <root> --language <lang> [--label L] [--grammar F.wasm] [--ext a,b] [--out F] [--rows F] [--parity] [--fixtures-only]');
    process.exit(2);
  }

  const core = req('dist/src/core/elision/regions.js');
  const deepRegions = req('packages/deep/dist/regions.js');
  const runtime = await loadRuntime(opts.language, opts.grammar);
  const { spec } = runtime;

  // Check 2: known answers. Shipped languages are covered by --parity against core instead.
  const fixtures = runFixtures(opts.language, runtime, core, deepRegions);
  if (fixtures.failures.length > 0) {
    throw new Refusal(
      `REFUSED (check 2): ${fixtures.failures.length} of ${fixtures.total} ${opts.language} fixtures failed\n` +
        JSON.stringify(fixtures.failures, null, 2),
    );
  }
  console.log(`fixtures: ${fixtures.total}/${fixtures.total} pass (${opts.language}, ${runtime.grammar.abiVersion ? `ABI ${runtime.grammar.abiVersion}` : 'ABI ?'})`);
  if (opts.fixturesOnly) return;

  let parity = null;
  if (opts.parity) {
    if (!spec.shipped) {
      throw new Refusal('REFUSED: --parity compares against core, which only knows the shipped languages');
    }
    const registry = req('dist/src/core/parser/registry.js');
    const constructors = req('dist/src/core/model/constructors.js');
    const deep = req('packages/deep/dist/index.js');
    registry.clearParserBackends();
    for (const backend of await deep.createDeepBackends()) {
      if (backend.language !== 'javascript') registry.registerParserBackend(backend);
    }
    parity = { registry, constructors, compared: 0, mismatched: [] };
  }

  const root = path.resolve(opts.root);
  const exts = opts.ext ?? spec.exts;
  const { files, vendored } = walkCorpus(root, exts, opts.exclude);
  const unmatchedExcludes = opts.exclude.filter((d) => !vendored.includes(d));
  if (unmatchedExcludes.length > 0) {
    // An exclusion that matched nothing is a typo, and a typo here silently keeps a vendored
    // tree in the measurement.
    throw new Refusal(`REFUSED: --exclude matched no directory: ${unmatchedExcludes.join(', ')}`);
  }
  if (files.length === 0) {
    throw new Refusal(`REFUSED: 0 files with extension(s) ${exts.join(',')} under ${root} — the shape a bad glob produces`);
  }

  const rows = [];
  const listHash = crypto.createHash('sha256');
  for (const abs of files) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const content = fs.readFileSync(abs, 'utf8');
    listHash.update(`${rel}\0${sha256(content)}\n`);
    const cls = classify(rel, content);
    const tree = runtime.parser.parse(content);
    if (tree === null) throw new Error(`parser returned no tree for ${rel}`);
    try {
      const { all, fnOnly } = candidateRegions(tree, content, opts.language, spec, deepRegions);
      const { kept, counts } = filterRegions(content, all, spec.stripAs, core, core.MIN_REGION_BYTES);
      const fnKept = fnOnly ? filterRegions(content, fnOnly, spec.stripAs, core, core.MIN_REGION_BYTES).kept : null;
      const regionBytes = kept.reduce((n, r) => n + (r.end - r.start), 0);

      let disagreements = 0;
      if (!spec.shipped) {
        // Every candidate that cleared the size floor: does the borrowed stripper agree with the
        // grammar about whether it holds anything but comments?
        for (const region of dropOverlapping(all)) {
          const text = content.slice(region.start, region.end);
          if (text.length < core.MIN_REGION_BYTES) continue;
          if (core.isSubstantiveRegion(text, spec.stripAs) !== treeSubstantive(tree, spec, region)) disagreements += 1;
        }
      }

      const row = {
        path: rel,
        group: rel.split('/')[0],
        class: cls,
        bytes: content.length,
        regions: kept.length,
        regionBytes,
        cleanRegionBytes: spec.shipped ? null : kept.filter((r) => r.clean).reduce((n, r) => n + (r.end - r.start), 0),
        fnRegionBytes: fnKept ? fnKept.reduce((n, r) => n + (r.end - r.start), 0) : null,
        droppedSmall: counts.small,
        droppedInsubstantive: counts.insubstantive,
        stripperTreeDisagreements: disagreements,
        unbalancedRegions: LEXABLE.has(opts.language) ? kept.filter((r) => !lexBalanced(content.slice(r.start, r.end))).length : null,
        parseError: tree.rootNode.hasError,
      };

      if (opts.language === 'rust') {
        const spans = rustInlineTestSpans(tree);
        row.inlineTestBytes = spans.reduce((n, s) => n + (s.end - s.start), 0);
        row.inlineTestRegionBytes = overlapBytes(kept, spans);
      }

      if (parity) {
        const item = parity.constructors.createContextItem({ id: rel, kind: 'file', contentType: 'code', content, path: abs });
        const coreDeep = core.selectElisionRegions(item, { mode: 'deep' }).map((r) => [r.start, r.end]);
        const mine = kept.map((r) => [r.start, r.end]);
        parity.compared += 1;
        if (JSON.stringify(coreDeep) !== JSON.stringify(mine)) parity.mismatched.push(rel);
        const fast = core.selectElisionRegions(item, { mode: 'fast' });
        row.fastRegionBytes = fast.reduce((n, r) => n + (r.end - r.start), 0);
      }

      rows.push(row);
    } finally {
      tree.delete();
    }
  }

  if (parity && parity.mismatched.length > 0) {
    throw new Refusal(
      `REFUSED (parity): instrument regions differ from core's selectElisionRegions on ${parity.mismatched.length} of ${parity.compared} files:\n` +
        parity.mismatched.slice(0, 20).join('\n'),
    );
  }

  const classes = {};
  for (const cls of ['source', 'test', 'generated']) {
    const subset = rows.filter((r) => r.class === cls);
    if (subset.length > 0) classes[cls] = aggregate(subset);
  }
  const nonGenerated = rows.filter((r) => r.class !== 'generated');
  const groups = {};
  for (const group of [...new Set(rows.map((r) => r.group))].sort()) {
    const subset = rows.filter((r) => r.group === group);
    groups[group] = { ...aggregate(subset), testFiles: subset.filter((r) => r.class === 'test').length, generatedFiles: subset.filter((r) => r.class === 'generated').length };
  }

  const report = {
    createdAt: new Date().toISOString(),
    label: opts.label ?? path.basename(root),
    language: opts.language,
    corpus: { root: root.replace(/\\/g, '/'), files: rows.length, extensions: exts, listHash: listHash.digest('hex'), vendoredDirsSkipped: vendored },
    engine: pinEngine(),
    grammar: grammarPin(runtime.wasmPath),
    minRegionBytes: core.MIN_REGION_BYTES,
    fixtures: `${fixtures.total}/${fixtures.total}`,
    parity: parity ? { compared: parity.compared, mismatched: 0 } : null,
    classes,
    // Per corpus. A language clears only if it clears on **each** of its two corpora; this
    // file sees one corpus at a time and never averages across them.
    floor: {
      threshold: FLOOR,
      basis: 'source class (test and generated excluded)',
      sourceCeiling: classes.source?.ceiling ?? null,
      clears: classes.source ? classes.source.ceiling >= FLOOR : null,
    },
    allButGenerated: aggregate(nonGenerated),
    all: aggregate(rows),
    groups,
  };

  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  if (opts.rows) fs.writeFileSync(opts.rows, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  console.log(`${report.label} · ${opts.language} · ${rows.length} files · grammar ${report.grammar.package ?? '?'} · engine ${report.engine.commit.slice(0, 7)}${report.engine.dirty ? ' (DIRTY)' : ''}`);
  if (vendored.length > 0) console.log(`vendored directories skipped: ${vendored.length}`);
  if (parity) console.log(`parity: ${parity.compared}/${parity.compared} files identical to core selectElisionRegions (deep)`);
  console.log('');
  console.log('class        files      bytes   ceiling  fn-only   median  no-rgn(f) no-rgn(b) parse-err   clean  err-free' + (parity ? '   fast' : ''));
  const line = (name, a) =>
    console.log(
      `${name.padEnd(10)} ${String(a.files).padStart(6)} ${String(a.bytes).padStart(10)}  ${pct(a.ceiling)} ${pct(a.ceilingFunctionsOnly)} ${pct(a.medianFileCeiling)}   ${pct(a.noRegionFiles)}  ${pct(a.noRegionBytes)}  ${pct(a.parseErrorFiles)} ${pct(a.ceilingCleanRegions)} ${pct(a.ceilingErrorFreeFiles)}` +
        (a.fastCeiling !== undefined ? ` ${pct(a.fastCeiling)}` : ''),
    );
  for (const [cls, a] of Object.entries(classes)) line(cls, a);
  line('non-gen', report.allButGenerated);
  line('all', report.all);
  if (report.classes.source?.ceilingExcludingInlineTests !== undefined) {
    const s = report.classes.source;
    console.log(`\nrust source: ${pct(s.inlineTestBytes / s.bytes)} of bytes are #[cfg(test)] modules; ceiling excluding them ${pct(s.ceilingExcludingInlineTests)}`);
  }
  const a = report.all;
  console.log(
    `\nregions ${a.regions} · dropped <${core.MIN_REGION_BYTES}B ${a.droppedSmall} · dropped insubstantive ${a.droppedInsubstantive} · stripper/tree disagreements ${a.stripperTreeDisagreements}` +
      (a.unbalancedRegions !== null ? ` · unbalanced under an independent lexer ${a.unbalancedRegions}` : ''),
  );
  const f = report.floor;
  console.log(
    f.clears === null
      ? `floor ${pct(FLOOR)}: no source files in this corpus — no verdict`
      : `floor ${pct(FLOOR)} on source: ${pct(f.sourceCeiling)} -> ${f.clears ? 'CLEARS' : 'BELOW'} on this corpus (a language needs both of its corpora)`,
  );
}

// The pure parts are exported so `test/unit/corpus-harness-ceiling.test.ts` can pin them
// without a grammar: classification is the rule this file had to correct twice before any
// candidate was measured, and the independent lexer is what vouches for boundaries.
module.exports = {
  FLOOR,
  LANGUAGES,
  FIXTURES,
  classify,
  dropOverlapping,
  lexBalanced,
  braceInterior,
  rubyInterior,
  candidateRegions,
  filterRegions,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Refusal ? err.message : err);
    process.exitCode = 1;
  });
}

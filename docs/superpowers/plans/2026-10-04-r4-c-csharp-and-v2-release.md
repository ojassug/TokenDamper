# R4 and v2.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship TokenDamper v2.0.0, its final release. C and C# reduce under `--mode deep`;
`tokendamper-deep` is published; `--mode` means `fast|deep`; every held item is closed.

**Architecture:**
- C and C# are *deep-only* languages. Function bodies and function symbols come from the
  tree-sitter backend in `packages/deep`.
- Core gains one bracket/quote lexer per language, for two reasons: the Fast chain must name a
  language before Deep is consulted, and Deep cannot validate its own marker (§81).
- A single helper, `deepOnlyBackend`, decides where backend symbols and regions apply, so the gate
  and the drift gate cannot disagree.

**Tech Stack:** TypeScript (CommonJS, Node ≥ 20.19), vitest, web-tree-sitter 0.27 with
`tree-sitter-c` 0.24.1 and `tree-sitter-c-sharp` 0.23.5, and the Node scripts in
`tools/corpus-harness`.

**Spec:** `docs/superpowers/specs/2026-10-04-r4-c-csharp-and-v2-release-design.md`. Read it first;
this plan argues from it and cites it as "spec §n".

## Global Constraints

- Node `^20.19.0 || ^22.13.0 || >=24`, CommonJS, and **core has zero runtime dependencies**.
  Grammars go in `packages/deep` only.
- **Invariant 1 is per-configuration.** Same input, same mode, same bytes. Fast-mode output on
  every existing language must stay **byte-identical** through Parts A and B.
- **Only `stage-registry` value-imports a stage.** `src/core` and `src/stages` never import from
  `adapters/`, `cli/` or `gateway/`; the linter enforces both.
- **Validators never mutate. Fallback is fail-open. Pinned items bypass the knapsack.**
- **Pre-registered lexer bar (spec §4.2):** at most 0.1% false positives on at least 5,000 real
  files per language, every flagged file read, and at least 95% mutation catch. A language that
  misses the bar does not ship. The bar is never loosened.
- **Regions come last (spec §3).** Nothing may make a C or C# region reachable before the
  backend-symbol step has been measured.
- **Line endings.** The working tree is CRLF and blobs are LF (`git ls-files --eol` shows
  `i/lf w/crlf`). Scripted edits read and write bytes, preserving `\r\n`; new files may be LF.
- **Measurement discipline (`measure-corpus` skill).**
  - Freeze the corpus, pin it, and vary only `dist/`. Diff per row and assert the row count.
  - Byte-identical is not inert: check whether the corpus contains the shape you changed.
  - **The prose bucket counts `docs/**/*.md`.** Every added or deleted doc moves `recipe.json`'s
    `prose.expect` in the same commit, with the file named in `$comment`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end
  with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Merges, npm publish, tags.** Every `gh pr merge` needs the owner's approval for that PR
  number; ask once for every PR that is ready. The owner runs `npm publish` (2FA). Never
  `cd` to the main checkout to install, and use `npm ci`/`npm install` in the worktree only.

## Branches and PRs

| PR | branch | base | contents |
|---|---|---|---|
| A | `r4/languages` | `r4/spec` (spec + this plan) | Tasks 1–12 |
| B | `r4/surface` | `r4/languages` | Tasks 13–17 |
| C | `release/v2.0.0` | `main` after A and B merge | Tasks 18–19 |

Corpora live outside the repository:
`C:/Users/ojass/AppData/Local/Temp/claude/C--Users-ojass-Projects-TokenDamper--claude-worktrees-tokendamper-2-0-0-release-04fba2/cc20f252-f3b5-416e-b1a9-07e74dd26340/scratchpad/r4-corpora/`,
written `$CORPORA` below. Every clone is recorded by full commit SHA in the DECISIONS entry that
uses it.

---

## Part A — the languages (PR A)

### Task 1: C# is a declarable, classifiable language

**Files:**
- Modify: `src/core/model/constructors.ts`. In the `DeclaredLanguage` union add `'csharp'`; in
  `LANGUAGE_ALIASES` add `cs`, `csharp` and `c#`; in `CONTENT_TYPE_BY_LANGUAGE` add
  `csharp: 'code'`; in `isCodeExtension` add `'cs'`.
- Modify: `src/cli/ingest.ts:27-30`, adding `'cs'` to `INGESTIBLE_EXTENSIONS`.
- Test: `test/unit/declared-language.test.ts` and `test/unit/cli/ingest.test.ts` (append).

**Interfaces:**
- Produces: `normalizeLanguage('c#' | 'cs' | 'csharp') === 'csharp'`,
  `contentTypeForLanguage('csharp') === 'code'`, and `classifyContent(x, 'file', 'a.cs') === 'code'`.

- [ ] **Step 1: Write the failing tests** (append to `test/unit/declared-language.test.ts`)

```ts
describe('C# is declarable and classifiable (R4, spec §4.1)', () => {
  it.each(['csharp', 'cs', 'c#', 'C#', ' CSharp '])('normalizes %j to csharp', (spelling) => {
    expect(normalizeLanguage(spelling)).toBe('csharp');
  });

  it('declares code, like every other programming language', () => {
    expect(contentTypeForLanguage('csharp')).toBe('code');
  });

  it('classifies a .cs path as code — the filename route and the declaration route agree', () => {
    expect(classifyContent('class A { }', 'file', 'src/A.cs')).toBe('code');
  });
});
```

Import `normalizeLanguage`, `contentTypeForLanguage` and `classifyContent` from
`../../src/core/model/constructors` if the file does not already. Append to
`test/unit/cli/ingest.test.ts`, following that file's existing temp-directory pattern for
`expandPath`:

```ts
it('walks .cs files like any other recognised source (R4)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tokendamper-ingest-cs-'));
  writeFileSync(join(dir, 'A.cs'), 'class A { }\n', 'utf8');
  writeFileSync(join(dir, 'notes.xyz'), 'ignored\n', 'utf8');
  expect(expandPath(dir, dir).map((p) => basename(p))).toEqual(['A.cs']);
});
```

Add `import { basename } from 'node:path'` and the `mkdtempSync`/`writeFileSync`/`tmpdir` imports
if absent.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/declared-language.test.ts test/unit/cli/ingest.test.ts`
Expected: FAIL. `normalizeLanguage('cs')` returns `undefined`; `.cs` classifies as `text`; the
walk returns `[]`.

- [ ] **Step 3: Implement**

In `constructors.ts`:

```ts
export type DeclaredLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'shell'
  // …the rest of the union unchanged
```

In `LANGUAGE_ALIASES`, after the `hpp: 'cpp',` line:

```ts
  // C# (R4, spec §4.1). `cs` is the extension spelling, as `py` and `hpp` are above.
  cs: 'csharp',
  csharp: 'csharp',
  'c#': 'csharp',
```

In `CONTENT_TYPE_BY_LANGUAGE`, after `cpp: 'code',`:

```ts
  csharp: 'code',
```

In `isCodeExtension`, the list becomes:

```ts
  return ['ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'sh', 'ps1', 'css', 'scss', 'sql'].includes(extension);
```

In `src/cli/ingest.ts`:

```ts
const INGESTIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts', 'tsx', 'js', 'jsx', 'cjs', 'mjs', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
  'sh', 'ps1', 'css', 'scss', 'sql', 'json', 'md', 'txt', 'yml', 'yaml',
]);
```

- [ ] **Step 4: Run them and see them pass, then run the whole suite**

Run: `npx vitest run test/unit/declared-language.test.ts test/unit/cli/ingest.test.ts`, then `npx vitest run`
Expected: PASS. Any other failure is a test pinning the old nineteen-entry list; update it so it
names `cs`, and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/core/model/constructors.ts src/cli/ingest.ts test/unit/declared-language.test.ts test/unit/cli/ingest.test.ts
git commit -m "feat(model): C# is declarable and classifiable (R4)" -m "csharp joins DeclaredLanguage (aliases cs, c#) and .cs joins both extension lists, which stay separate (design §3.8). Nothing validates or elides C# yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `CValidator`, the C balance lexer

**Files:**
- Create: `src/core/validation/ast/c-validator.ts`
- Test: `test/unit/c-validator.test.ts`

**Interfaces:**
- Produces: `class CValidator implements AstValidator`, with `language === 'c'`, and
  `validate(content): AstCheckResult`.
- Issue codes: `AST_UNBALANCED_BRACKET`, `AST_UNTERMINATED_STRING`, `AST_UNTERMINATED_COMMENT`,
  and the new `AST_UNBALANCED_CONDITIONAL`.

- [ ] **Step 1: Write the failing test file** `test/unit/c-validator.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CValidator } from '../../src/core/validation/ast/c-validator';

/**
 * R4 step 1 — the C lexer (spec §4.2, DECISIONS §84).
 *
 * Against the unfixed engine every case fails to import, because the class does not exist. The
 * accept cases are the false-positive guards that matter most: validation runs over every output
 * item without subtracting what the input already had, so a false flag on an untouched `.c` file
 * makes a whole Fast-mode bundle fall back.
 */
const validator = new CValidator();
const verdict = (src: string) => validator.validate(src);
const codes = (src: string) => [...new Set(verdict(src).issues.map((i) => i.code))];
const MARKER = '[TokenDamper: 3 function body lines elided, 90 bytes, sha256:0123456789ab]';

describe('CValidator accepts balanced C', () => {
  it.each([
    ['nested blocks', 'int f(int a) {\n  if (a) { return 1; }\n  return 0;\n}\n'],
    ['a brace in a string', 'const char *s = "}{";\n'],
    ['braces and quotes in char literals', "char a = '{', b = '\\'', c = '\"';\n"],
    ['braces in both comment forms', '// }\n/* {\n  ( */\nint x;\n'],
    ['a macro whose body opens a brace', '#define BEGIN {\n#define END }\nint f(void) BEGIN return 0; END\n'],
    [
      'the extern "C" guard',
      '#ifdef __cplusplus\nextern "C" {\n#endif\nint f(void);\n#ifdef __cplusplus\n}\n#endif\n',
    ],
    [
      'an opener duplicated across #if branches',
      'void f(int a, int b) {\n#if X\n  if (a) {\n#else\n  if (b) {\n#endif\n    g();\n  }\n}\n',
    ],
    ['a #if 0 block that is unbalanced and full of apostrophes', '#if 0\nit doesn\'t { matter\n#endif\nint x;\n'],
    ['the live #else of an #if 0', '#if 0\n  {\n#else\nint ok(void) { return 1; }\n#endif\n'],
    ['an apostrophe in #error', '#error don\'t build this\nint x;\n'],
    ['a multi-line macro with spliced braces', '#define M(x) do { \\\n  f(x); \\\n} while (0)\nint y;\n'],
    ['a spliced line comment hiding a brace', '// a comment \\\n continued {\nint z;\n'],
    ['a string spliced across lines', 'const char *s = "ab\\\ncd";\n'],
    ['C23 digit separators', "int n = 1'000'000;\n"],
    ['a C++ raw string in a header', 'const char *r = R"(a "quoted" { brace)";\n'],
    ['a delimited raw string', 'const char *r = R"x(he said )" and { left)x";\n'],
    ['prefixed literals', "wchar_t w = L'x'; const char *u = u8\"utf\"; const wchar_t *l = L\"wide\";\n"],
    ['an include with angle brackets', '#include <sys/types.h>\n#include "local.h"\n'],
    ['CRLF line endings', 'int f(void)\r\n{\r\n  return 0;\r\n}\r\n'],
    ['a body TokenDamper has elided', `int f(void) {${MARKER}}\nint g(void) { return 1; }\n`],
  ])('%s', (_label, src) => {
    const result = verdict(src);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('CValidator rejects what it guarantees against', () => {
  it.each([
    ['an unclosed brace', 'int f(void) {\n  return 0;\n', 'AST_UNBALANCED_BRACKET'],
    ['a stray closing brace', 'int x;\n}\n', 'AST_UNBALANCED_BRACKET'],
    ['mismatched brackets', 'int a[3) ;\n', 'AST_UNBALANCED_BRACKET'],
    ['an unterminated string', 'const char *s = "abc;\nint x;\n', 'AST_UNTERMINATED_STRING'],
    ['an unterminated char literal', "char c = 'a;\n", 'AST_UNTERMINATED_STRING'],
    ['an unterminated block comment', 'int x; /* never closed\n', 'AST_UNTERMINATED_COMMENT'],
    ['an #endif with no #if', 'int x;\n#endif\n', 'AST_UNBALANCED_CONDITIONAL'],
    ['an #else with no #if', '#else\nint x;\n', 'AST_UNBALANCED_CONDITIONAL'],
    ['an #if never closed', '#ifdef X\nint x;\n', 'AST_UNBALANCED_CONDITIONAL'],
    [
      'an elision that split a conditional group',
      `int f(void) {${MARKER}}\n#else\n  g();\n}\n#endif\n`,
      'AST_UNBALANCED_CONDITIONAL',
    ],
  ])('%s', (_label, src, code) => {
    expect(verdict(src).valid).toBe(false);
    expect(codes(src)).toContain(code);
  });

  it('reports a position for every issue', () => {
    const [issue] = verdict('int f(void) {\n').issues;
    expect(issue).toMatchObject({ line: 1, code: 'AST_UNBALANCED_BRACKET' });
    expect(issue!.column).toBeGreaterThan(0);
  });

  it('is named c, which is the key a Deep backend is registered under', () => {
    expect(validator.language).toBe('c');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/c-validator.test.ts`
Expected: FAIL with `Failed to resolve import "../../src/core/validation/ast/c-validator"`.

- [ ] **Step 3: Implement** `src/core/validation/ast/c-validator.ts`

```ts
import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/** One `#if` group. Brackets count only while every enclosing group's open branch counts. */
interface ConditionalGroup {
  readonly line: number;
  /** Whether brackets count in the branch now open. */
  counting: boolean;
  /** Whether some branch of this group has already counted. */
  counted: boolean;
}

/** `R"delim( … )delim"`. C has no raw strings; a C++ header named `.h` does, and `.h` is C here. */
const RAW_STRING_PREFIXES: ReadonlySet<string> = new Set(['R', 'LR', 'uR', 'UR', 'u8R']);

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Bracket, quote, comment and conditional balance for C — R4, step 1 (spec §4.2, DECISIONS §84).
 *
 * **Why C does not reuse `TypeScriptValidator`.** The grammars share `//`, `/* *\/` and three
 * bracket pairs, and the resemblance is what makes reuse look free; `GoValidator`'s header records
 * what it cost there. For C the divergences are the preprocessor and literal forms:
 *
 *  - **Directives are not code.** `#define BEGIN {` is macro text, so brackets on a directive line,
 *    spliced continuation lines included, never count. A lone quote there is ordinary text too
 *    (`#error don't …`).
 *  - **Conditional groups.** Brackets count in the first branch of each `#if`/`#ifdef`/`#ifndef`
 *    group only, which is what makes the ubiquitous `#ifdef __cplusplus` / `extern "C" {` /
 *    `#endif` guard balance, and an opener duplicated across branches. `#if 0` is the one branch
 *    whose deadness is visible without evaluating anything. It is how C disables code, which may be
 *    unbalanced, so it never counts and its `#else` does. Groups must themselves balance: a region
 *    boundary that splits one is exactly the defect elision can introduce.
 *  - **Line splicing.** Backslash-newline joins lines everywhere except inside a raw string,
 *    including inside literals and `//` comments.
 *  - **Literals.** Character literals, prefixed literals (`L`, `u8`), C23 digit separators
 *    (`1'000'000` is one pp-number), and C++ raw strings for headers.
 *
 * **What it checks is balance, not syntax**, the same claim every Fast validator makes and the
 * README's table states. The elision marker spliced into a body is balanced, so this is the
 * post-condition check for C under `--mode deep` (DECISIONS §81 is why Deep cannot be).
 */
export class CValidator implements AstValidator {
  readonly language: TargetLanguage = 'c';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const scanner = new CScanner(content);
    scanner.run();
    return {
      valid: scanner.issues.length === 0,
      issues: Object.freeze(scanner.issues),
      durationMs: performance.now() - startTime,
    };
  }
}

class CScanner {
  readonly issues: AstIssue[] = [];
  private readonly stack: BracketStackItem[] = [];
  private readonly groups: ConditionalGroup[] = [];
  private i = 0;
  private line = 1;
  private column = 0;
  /** No token yet on this logical line, so a `#` here starts a directive. */
  private atLineStart = true;
  private inDirective = false;

  constructor(private readonly src: string) {}

  run(): void {
    const src = this.src;
    while (this.i < src.length) {
      if (this.splice()) continue;
      const ch = src[this.i]!;
      if (ch === '\n') {
        this.newline();
        this.atLineStart = true;
        this.inDirective = false;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
        this.advance();
        continue;
      }
      if (ch === '/' && src[this.i + 1] === '/') {
        this.lineComment();
        continue;
      }
      if (ch === '/' && src[this.i + 1] === '*') {
        this.blockComment();
        continue;
      }
      if (ch === '#' && this.atLineStart) {
        this.directive();
        continue;
      }
      this.atLineStart = false;
      if (ch === '"' || ch === "'") {
        this.quoted(ch);
        continue;
      }
      if (isIdentifierStart(ch)) {
        this.identifier();
        continue;
      }
      if (isDigit(ch) || (ch === '.' && isDigit(src[this.i + 1] ?? ''))) {
        this.number();
        continue;
      }
      if (!this.inDirective && this.counting()) {
        this.bracket(ch);
      }
      this.advance();
    }
    this.finish();
  }

  private advance(): void {
    this.i++;
    this.column++;
  }

  private newline(): void {
    this.i++;
    this.line++;
    this.column = 0;
  }

  /** Consumes a backslash-newline, which joins two physical lines into one logical line. */
  private splice(): boolean {
    if (this.src[this.i] !== '\\') return false;
    const next = this.src[this.i + 1];
    const width = next === '\n' ? 2 : next === '\r' && this.src[this.i + 2] === '\n' ? 3 : 0;
    if (width === 0) return false;
    this.i += width;
    this.line++;
    this.column = 0;
    return true;
  }

  private counting(): boolean {
    return this.groups.every((group) => group.counting);
  }

  private issue(line: number, column: number, message: string, code: string): void {
    this.issues.push({ line, column, message: `${message} at line ${line}, column ${column}`, code });
  }

  private lineComment(): void {
    while (this.i < this.src.length) {
      if (this.splice()) continue;
      if (this.src[this.i] === '\n') return;
      this.advance();
    }
  }

  private blockComment(): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance();
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === '*' && this.src[this.i + 1] === '/') {
        this.advance();
        this.advance();
        return;
      }
      if (ch === '\n') this.newline();
      else this.advance();
    }
    this.issue(line, column, 'Unterminated block comment', 'AST_UNTERMINATED_COMMENT');
  }

  private quoted(quote: '"' | "'"): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance();
    while (this.i < this.src.length) {
      if (this.splice()) continue;
      const ch = this.src[this.i];
      if (ch === '\n') break;
      if (ch === '\\') {
        this.advance();
        if (this.i < this.src.length && this.src[this.i] !== '\n') this.advance();
        continue;
      }
      this.advance();
      if (ch === quote) return;
    }
    // A lone quote in a directive is ordinary text, and a branch that does not count is not the
    // code this build compiles. Neither is a defect in this file.
    if (this.inDirective || !this.counting()) return;
    this.issue(
      line,
      column,
      quote === '"' ? 'Unterminated string literal' : 'Unterminated character literal',
      'AST_UNTERMINATED_STRING',
    );
  }

  private identifier(): void {
    const start = this.i;
    while (this.i < this.src.length && isIdentifierPart(this.src[this.i]!)) this.advance();
    if (this.src[this.i] === '"' && RAW_STRING_PREFIXES.has(this.src.slice(start, this.i))) {
      this.rawString();
    }
    // Any other prefix (`L`, `u`, `U`, `u8`) is followed by an ordinary literal, lexed next.
  }

  private rawString(): void {
    const line = this.line;
    const column = this.column + 1;
    const open = this.src.indexOf('(', this.i + 1);
    const delimiter = open === -1 ? '' : this.src.slice(this.i + 1, open);
    if (open === -1 || delimiter.length > 16 || /[\s\\()"]/.test(delimiter)) {
      // Not a raw-string opener after all: lex the ordinary literal it then is.
      this.quoted('"');
      return;
    }
    const closer = `)${delimiter}"`;
    const end = this.src.indexOf(closer, open + 1);
    const target = end === -1 ? this.src.length : end + closer.length;
    // No splicing inside: a raw string reverts it.
    while (this.i < target) {
      if (this.src[this.i] === '\n') this.newline();
      else this.advance();
    }
    if (end === -1 && !this.inDirective && this.counting()) {
      this.issue(line, column, 'Unterminated raw string literal', 'AST_UNTERMINATED_STRING');
    }
  }

  /**
   * A pp-number, lexed whole so that the `'` in `1'000'000` is a digit separator rather than the
   * start of a character literal.
   */
  private number(): void {
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      const next = this.src[this.i + 1] ?? '';
      if ((ch === 'e' || ch === 'E' || ch === 'p' || ch === 'P') && (next === '+' || next === '-')) {
        this.advance();
        this.advance();
        continue;
      }
      if (isIdentifierPart(ch) || ch === '.') {
        this.advance();
        continue;
      }
      if (ch === "'" && isIdentifierPart(next)) {
        this.advance();
        continue;
      }
      return;
    }
  }

  private directive(): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance(); // `#`
    this.atLineStart = false;
    this.inDirective = true;
    while (this.i < this.src.length) {
      if (this.splice()) continue;
      const ch = this.src[this.i];
      if (ch !== ' ' && ch !== '\t') break;
      this.advance();
    }
    const start = this.i;
    while (this.i < this.src.length && isIdentifierPart(this.src[this.i]!)) this.advance();
    const name = this.src.slice(start, this.i);

    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        const live = !(name === 'if' && this.restOfDirectiveIs('0'));
        this.groups.push({ line, counting: live, counted: live });
        return;
      }
      case 'elif':
      case 'elifdef':
      case 'elifndef':
      case 'else': {
        const group = this.groups[this.groups.length - 1];
        if (!group) {
          this.issue(line, column, `#${name} without a matching #if`, 'AST_UNBALANCED_CONDITIONAL');
          return;
        }
        // The first branch that may be live counts; after `#if 0` that is this one.
        group.counting = !group.counted;
        group.counted = true;
        return;
      }
      case 'endif':
        if (this.groups.pop() === undefined) {
          this.issue(line, column, '#endif without a matching #if', 'AST_UNBALANCED_CONDITIONAL');
        }
        return;
      default:
        return;
    }
  }

  /** Whether the rest of this directive line, comments removed, is exactly `expected`. */
  private restOfDirectiveIs(expected: string): boolean {
    const end = this.src.indexOf('\n', this.i);
    const rest = this.src
      .slice(this.i, end === -1 ? this.src.length : end)
      .replace(/\/\*.*?\*\//g, ' ')
      .replace(/\/\/.*$/, '')
      .trim();
    return rest === expected;
  }

  private bracket(ch: string): void {
    if (ch === '(' || ch === '[' || ch === '{') {
      this.stack.push({ char: ch, line: this.line, column: this.column + 1 });
      return;
    }
    if (ch !== ')' && ch !== ']' && ch !== '}') return;
    const top = this.stack.pop();
    if (top === undefined) {
      this.issue(this.line, this.column + 1, `Unexpected closing bracket '${ch}'`, 'AST_UNBALANCED_BRACKET');
      return;
    }
    const opener = ch === ')' ? '(' : ch === ']' ? '[' : '{';
    if (top.char !== opener) {
      this.issue(
        this.line,
        this.column + 1,
        `Mismatched closing bracket '${ch}' (expected a match for '${top.char}' opened at line ${top.line}, column ${top.column})`,
        'AST_UNBALANCED_BRACKET',
      );
    }
  }

  private finish(): void {
    for (const group of this.groups) {
      this.issue(group.line, 1, 'Unterminated #if (no matching #endif)', 'AST_UNBALANCED_CONDITIONAL');
    }
    for (const top of this.stack) {
      this.issue(top.line, top.column, `Unclosed bracket '${top.char}'`, 'AST_UNBALANCED_BRACKET');
    }
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run test/unit/c-validator.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/validation/ast/c-validator.ts test/unit/c-validator.test.ts
git commit -m "feat(validation): CValidator, a C balance lexer (R4)" -m "Brackets, quotes, comments and conditional groups, with directive lines, splices, #if 0 and the extern \"C\" guard handled. Not wired into selection yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `CSharpValidator`, the C# balance lexer

**Files:**
- Create: `src/core/validation/ast/csharp-validator.ts`
- Test: `test/unit/csharp-validator.test.ts`

**Interfaces:**
- Produces: `class CSharpValidator implements AstValidator`, with `language === 'csharp'`.
- Issue codes are the same four as Task 2.

- [ ] **Step 1: Write the failing test file** `test/unit/csharp-validator.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { CSharpValidator } from '../../src/core/validation/ast/csharp-validator';

/**
 * R4 step 1 — the C# lexer (spec §4.2, DECISIONS §84). Every case fails against the unfixed
 * engine, where the class does not exist. The accept cases are C#'s literal forms, each of which
 * defeats a TypeScript-style lexer.
 */
const validator = new CSharpValidator();
const verdict = (src: string) => validator.validate(src);
const codes = (src: string) => [...new Set(verdict(src).issues.map((i) => i.code))];
const MARKER = '[TokenDamper: 3 function body lines elided, 90 bytes, sha256:0123456789ab]';

describe('CSharpValidator accepts balanced C#', () => {
  it.each([
    ['a class with nested blocks', 'namespace N {\n  class A {\n    int F(int x) { if (x > 0) { return 1; } return 0; }\n  }\n}\n'],
    ['escapes in a regular string', 'var s = "}\\"{";\n'],
    ['a multi-line verbatim string', 'var p = @"C:\\path\\{\n "" }";\n'],
    ['interpolation with literal braces and a format', 'var s = $"{a} {{literal}} {b:N2} {(x ? "y" : "z")}";\n'],
    ['nested interpolation', 'var s = $"{$"{inner}"}";\n'],
    ['an anonymous object in a hole', 'var s = $"{new { A = 1 }.A}";\n'],
    ['verbatim interpolation, both orders', 'var a = $@"{x}\\dir"; var b = @$"{y}\\dir";\n'],
    ['a raw string literal', 'var r = """\n  He said "hi" {braces}\n  """;\n'],
    ['an interpolated raw string with $$', 'var j = $$"""{"json": {{value}}}""";\n'],
    ['char literals', "char a = '{', b = '\\'', c = '\"';\n"],
    [
      'an opener duplicated across #if branches',
      'class A {\n  void F() {\n#if DEBUG\n    if (a) {\n#else\n    if (b) {\n#endif\n      G();\n    }\n  }\n}\n',
    ],
    ['an apostrophe in a #region name', '#region Don\'t touch\nclass A { }\n#endregion\n'],
    ['a #if false block that would not lex', '#if false\nit doesn\'t { even "parse\n#endif\nclass A { }\n'],
    ['attributes, generics and a verbatim identifier', '[Fact]\npublic void T(List<Dictionary<string, int>> @class) { }\n'],
    ['braces in comments', '// }\n/* {\n ( */\nclass A { }\n'],
    ['a body TokenDamper has elided', `class A {\n  int F() {${MARKER}}\n}\n`],
    ['CRLF line endings', 'class A\r\n{\r\n  void F() { }\r\n}\r\n'],
  ])('%s', (_label, src) => {
    const result = verdict(src);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe('CSharpValidator rejects what it guarantees against', () => {
  it.each([
    ['an unclosed brace', 'class A {\n  void F() { }\n', 'AST_UNBALANCED_BRACKET'],
    ['a stray closing brace', 'class A { }\n}\n', 'AST_UNBALANCED_BRACKET'],
    ['an unterminated regular string', 'var s = "abc;\nvar t = 1;\n', 'AST_UNTERMINATED_STRING'],
    ['an unterminated verbatim string', 'var s = @"abc\nmore', 'AST_UNTERMINATED_STRING'],
    ['an unterminated raw string', 'var r = """\n text\n', 'AST_UNTERMINATED_STRING'],
    ['an unterminated char literal', "char c = 'a;\n", 'AST_UNTERMINATED_STRING'],
    ['an unterminated block comment', 'class A { } /* never closed\n', 'AST_UNTERMINATED_COMMENT'],
    ['an #endif with no #if', 'class A { }\n#endif\n', 'AST_UNBALANCED_CONDITIONAL'],
    ['an #endregion with no #region', 'class A { }\n#endregion\n', 'AST_UNBALANCED_CONDITIONAL'],
    ['an #if never closed', '#if DEBUG\nclass A { }\n', 'AST_UNBALANCED_CONDITIONAL'],
    ['a #region never closed', '#region R\nclass A { }\n', 'AST_UNBALANCED_CONDITIONAL'],
  ])('%s', (_label, src, code) => {
    expect(verdict(src).valid).toBe(false);
    expect(codes(src)).toContain(code);
  });

  it('is named csharp, which is the key a Deep backend is registered under', () => {
    expect(validator.language).toBe('csharp');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/csharp-validator.test.ts`
Expected: FAIL with an unresolved import.

- [ ] **Step 3: Implement** `src/core/validation/ast/csharp-validator.ts`

```ts
import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

interface ConditionalGroup {
  readonly line: number;
  counting: boolean;
  counted: boolean;
}

/** An interpolation hole: closed by `braces` consecutive `}` at depth 0 (the `$` count for raw). */
interface Hole {
  readonly braces: number;
}

const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

/**
 * Bracket, quote, comment and directive balance for C# — R4, step 1 (spec §4.2, DECISIONS §84).
 *
 * C#'s literal forms are what a borrowed lexer gets wrong:
 *
 *  - **Verbatim strings** (`@"…"`) span lines, have no backslash escapes, and escape a quote as
 *    `""`, so `@"C:\dir\"` ends where a C-style lexer thinks it continues.
 *  - **Raw strings** (`"""…"""`, any run of three or more) span lines and contain quotes freely.
 *  - **Interpolation** (`$"…{expr}…"`, `$@`, `@$`, `$$"""…{{expr}}…"""`) puts *code* inside a
 *    string, with its own brackets and nested strings; `{{` and `}}` are literal braces, and in a
 *    raw string N `$` signs mean a hole opens with N braces. Brackets inside a hole balance on
 *    their own, so a hole cannot close a bracket the code around its string opened.
 *  - **Directives** occupy whole lines and are not lexed. `#region Don't touch` is ordinary text.
 *    The first-branch rule for `#if` is `CValidator`'s, with `#if false` as the visibly dead
 *    branch. A skipped section is not lexed at all, which is the C# specification's own rule.
 *    `#region`/`#endregion` must balance.
 *
 * **Balance, not syntax** — the Fast path's claim, and the post-condition for C# under
 * `--mode deep`.
 */
export class CSharpValidator implements AstValidator {
  readonly language: TargetLanguage = 'csharp';

  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const scanner = new CSharpScanner(content);
    scanner.run();
    return {
      valid: scanner.issues.length === 0,
      issues: Object.freeze(scanner.issues),
      durationMs: performance.now() - startTime,
    };
  }
}

class CSharpScanner {
  readonly issues: AstIssue[] = [];
  private readonly stack: BracketStackItem[] = [];
  private readonly groups: ConditionalGroup[] = [];
  private readonly regions: number[] = [];
  private i = 0;
  private line = 1;
  private column = 0;
  private atLineStart = true;

  constructor(private readonly src: string) {}

  run(): void {
    this.code(null);
    this.finish();
  }

  private advance(): void {
    this.i++;
    this.column++;
  }

  private newline(): void {
    this.i++;
    this.line++;
    this.column = 0;
  }

  private counting(): boolean {
    return this.groups.every((group) => group.counting);
  }

  private issue(line: number, column: number, message: string, code: string): void {
    this.issues.push({ line, column, message: `${message} at line ${line}, column ${column}`, code });
  }

  private runOf(ch: string): number {
    let n = 0;
    while (this.src[this.i + n] === ch) n++;
    return n;
  }

  /**
   * Lexes code to the end of input, or — for a hole — to the `}` run that closes it at depth 0.
   * Returns whether a hole closed.
   */
  private code(hole: Hole | null): boolean {
    const stack: BracketStackItem[] = hole === null ? this.stack : [];
    const src = this.src;
    while (this.i < src.length) {
      if (hole === null && this.atLineStart && !this.counting()) {
        this.skippedLine();
        continue;
      }
      const ch = src[this.i]!;
      if (ch === '\n') {
        this.newline();
        if (hole === null) this.atLineStart = true;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
        this.advance();
        continue;
      }
      if (ch === '/' && src[this.i + 1] === '/') {
        this.lineComment();
        continue;
      }
      if (ch === '/' && src[this.i + 1] === '*') {
        this.blockComment();
        continue;
      }
      if (hole === null && ch === '#' && this.atLineStart) {
        this.directive();
        continue;
      }
      this.atLineStart = false;
      if (hole !== null && stack.length === 0) {
        if (ch === '}' && this.runOf('}') >= hole.braces) {
          for (let b = 0; b < hole.braces; b++) this.advance();
          return true;
        }
        if (ch === ':') {
          return this.format(hole);
        }
      }
      if ((ch === '"' || ch === '@' || ch === '$') && this.stringLiteral()) continue;
      if (ch === "'") {
        this.charLiteral();
        continue;
      }
      if (isIdentifierPart(ch)) {
        while (this.i < src.length && isIdentifierPart(src[this.i]!)) this.advance();
        continue;
      }
      this.bracket(stack, ch);
      this.advance();
    }
    return false;
  }

  /** A format specifier runs from the `:` to the `}` run that closes its hole. */
  private format(hole: Hole): boolean {
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '}' && this.runOf('}') >= hole.braces) {
        for (let b = 0; b < hole.braces; b++) this.advance();
        return true;
      }
      if (ch === '\n') this.newline();
      else this.advance();
    }
    return false;
  }

  /** Lexes the string literal starting here, if one does. */
  private stringLiteral(): boolean {
    let j = this.i;
    let dollars = 0;
    let verbatim = false;
    while (this.src[j] === '$') {
      dollars++;
      j++;
    }
    if (this.src[j] === '@') {
      verbatim = true;
      j++;
      while (this.src[j] === '$') {
        dollars++;
        j++;
      }
    }
    if (this.src[j] !== '"') return false;
    let quotes = 0;
    while (this.src[j + quotes] === '"') quotes++;
    const line = this.line;
    const column = this.column + 1;
    while (this.i < j) this.advance();
    if (verbatim) this.verbatimString(dollars > 0, line, column);
    else if (quotes >= 3) this.rawString(quotes, dollars, line, column);
    else this.regularString(dollars > 0, line, column);
    return true;
  }

  private regularString(interpolated: boolean, line: number, column: number): void {
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '\n') break;
      if (ch === '\\') {
        this.advance();
        if (this.i < this.src.length && this.src[this.i] !== '\n') this.advance();
        continue;
      }
      if (ch === '"') {
        this.advance();
        return;
      }
      if (interpolated && (ch === '{' || ch === '}')) {
        if (this.src[this.i + 1] === ch) {
          this.advance();
          this.advance();
          continue;
        }
        if (ch === '{') {
          this.advance();
          if (!this.code({ braces: 1 })) break;
          continue;
        }
      }
      this.advance();
    }
    this.issue(line, column, 'Unterminated string literal', 'AST_UNTERMINATED_STRING');
  }

  private verbatimString(interpolated: boolean, line: number, column: number): void {
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '"') {
        if (this.src[this.i + 1] === '"') {
          this.advance();
          this.advance();
          continue;
        }
        this.advance();
        return;
      }
      if (interpolated && (ch === '{' || ch === '}')) {
        if (this.src[this.i + 1] === ch) {
          this.advance();
          this.advance();
          continue;
        }
        if (ch === '{') {
          this.advance();
          if (!this.code({ braces: 1 })) break;
          continue;
        }
      }
      if (ch === '\n') this.newline();
      else this.advance();
    }
    this.issue(line, column, 'Unterminated verbatim string literal', 'AST_UNTERMINATED_STRING');
  }

  private rawString(quotes: number, dollars: number, line: number, column: number): void {
    for (let q = 0; q < quotes; q++) this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '"' && this.runOf('"') >= quotes) {
        for (let q = 0; q < quotes; q++) this.advance();
        return;
      }
      if (dollars > 0 && ch === '{') {
        const run = this.runOf('{');
        for (let b = 0; b < run; b++) this.advance();
        // A run of at least `dollars` braces opens a hole; any braces before the last `dollars` are content.
        if (run >= dollars && !this.code({ braces: dollars })) break;
        continue;
      }
      if (ch === '\n') this.newline();
      else this.advance();
    }
    this.issue(line, column, 'Unterminated raw string literal', 'AST_UNTERMINATED_STRING');
  }

  private charLiteral(): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i]!;
      if (ch === '\n') break;
      if (ch === '\\') {
        this.advance();
        if (this.i < this.src.length && this.src[this.i] !== '\n') this.advance();
        continue;
      }
      this.advance();
      if (ch === "'") return;
    }
    this.issue(line, column, 'Unterminated character literal', 'AST_UNTERMINATED_STRING');
  }

  private lineComment(): void {
    while (this.i < this.src.length && this.src[this.i] !== '\n') this.advance();
  }

  private blockComment(): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance();
    this.advance();
    while (this.i < this.src.length) {
      const ch = this.src[this.i];
      if (ch === '*' && this.src[this.i + 1] === '/') {
        this.advance();
        this.advance();
        return;
      }
      if (ch === '\n') this.newline();
      else this.advance();
    }
    this.issue(line, column, 'Unterminated block comment', 'AST_UNTERMINATED_COMMENT');
  }

  /** In a skipped section only a directive is processed; everything else is passed over unlexed. */
  private skippedLine(): void {
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t' || this.src[this.i] === '\r') this.advance();
    if (this.src[this.i] === '#') {
      this.directive();
      return;
    }
    this.atLineStart = false;
    this.skipToEndOfLine();
  }

  private skipToEndOfLine(): void {
    while (this.i < this.src.length && this.src[this.i] !== '\n') this.advance();
  }

  private directive(): void {
    const line = this.line;
    const column = this.column + 1;
    this.advance(); // `#`
    this.atLineStart = false;
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.advance();
    const start = this.i;
    while (this.i < this.src.length && /[a-z]/.test(this.src[this.i]!)) this.advance();
    const name = this.src.slice(start, this.i);
    const end = this.src.indexOf('\n', this.i);
    const rest = this.src
      .slice(this.i, end === -1 ? this.src.length : end)
      .replace(/\/\/.*$/, '')
      .trim();

    switch (name) {
      case 'if': {
        const live = rest !== 'false';
        this.groups.push({ line, counting: live, counted: live });
        break;
      }
      case 'elif':
      case 'else': {
        const group = this.groups[this.groups.length - 1];
        if (!group) {
          this.issue(line, column, `#${name} without a matching #if`, 'AST_UNBALANCED_CONDITIONAL');
          break;
        }
        group.counting = !group.counted;
        group.counted = true;
        break;
      }
      case 'endif':
        if (this.groups.pop() === undefined) {
          this.issue(line, column, '#endif without a matching #if', 'AST_UNBALANCED_CONDITIONAL');
        }
        break;
      case 'region':
        if (this.counting()) this.regions.push(line);
        break;
      case 'endregion':
        if (this.counting() && this.regions.pop() === undefined) {
          this.issue(line, column, '#endregion without a matching #region', 'AST_UNBALANCED_CONDITIONAL');
        }
        break;
      default:
        break;
    }
    this.skipToEndOfLine();
  }

  private bracket(stack: BracketStackItem[], ch: string): void {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ char: ch, line: this.line, column: this.column + 1 });
      return;
    }
    if (ch !== ')' && ch !== ']' && ch !== '}') return;
    const top = stack.pop();
    if (top === undefined) {
      this.issue(this.line, this.column + 1, `Unexpected closing bracket '${ch}'`, 'AST_UNBALANCED_BRACKET');
      return;
    }
    const opener = ch === ')' ? '(' : ch === ']' ? '[' : '{';
    if (top.char !== opener) {
      this.issue(
        this.line,
        this.column + 1,
        `Mismatched closing bracket '${ch}' (expected a match for '${top.char}' opened at line ${top.line}, column ${top.column})`,
        'AST_UNBALANCED_BRACKET',
      );
    }
  }

  private finish(): void {
    for (const group of this.groups) {
      this.issue(group.line, 1, 'Unterminated #if (no matching #endif)', 'AST_UNBALANCED_CONDITIONAL');
    }
    for (const regionLine of this.regions) {
      this.issue(regionLine, 1, 'Unterminated #region (no matching #endregion)', 'AST_UNBALANCED_CONDITIONAL');
    }
    for (const top of this.stack) {
      this.issue(top.line, top.column, `Unclosed bracket '${top.char}'`, 'AST_UNBALANCED_BRACKET');
    }
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run test/unit/csharp-validator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/validation/ast/csharp-validator.ts test/unit/csharp-validator.test.ts
git commit -m "feat(validation): CSharpValidator, a C# balance lexer (R4)" -m "Verbatim, raw and interpolated strings (holes lexed as code on their own stack), #if/#region balance, skipped sections unlexed. Not wired into selection yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Fast chain names C and C#

**Files:**
- Modify: `src/core/validation/ast/index.ts`. Export both validators, instantiate them, and add
  the branches to `selectFastValidator` (lines 156–193).
- Modify: `test/unit/validator-guarantee.test.ts` (append the C and C# rows).
- Modify: `test/unit/language-support.test.ts:46-57`, adding a `csharp` row; C and C# stay
  unsupported in Fast mode.
- Test: `test/unit/validator-coverage.test.ts` (append).

**Interfaces:**
- Produces: `selectValidator(item)` returns the C validator (`language 'c'`) for declared `c`/`h`
  or paths `.c`/`.h`, and the C# validator (`language 'csharp'`) for declared
  `csharp`/`cs`/`c#` or `.cs` paths.

- [ ] **Step 1: Write the failing tests** (append to `test/unit/validator-coverage.test.ts`)

```ts
describe('C and C# are validated, not skipped (R4, spec §4.1)', () => {
  const item = (content: string, extra: Partial<{ path: string; language: string }>) =>
    createContextItem({ id: 'x', kind: 'file', content, contentType: 'code', ...extra });

  it.each([
    [{ path: 'src/a.c' }, 'c'],
    [{ path: 'include/a.h' }, 'c'],
    [{ language: 'c' }, 'c'],
    [{ path: 'src/A.cs' }, 'csharp'],
    [{ language: 'csharp' }, 'csharp'],
    [{ language: 'cs' }, 'csharp'],
  ])('%j selects the %s validator', (extra, language) => {
    expect(selectValidator(item('int x;', extra))?.language).toBe(language);
  });

  it('reports validated: true for a .c file, which it never did before R4', () => {
    expect(validateItemAst(item('int x;\n', { path: 'a.c' })).validated).toBe(true);
  });

  it('leaves C++ unvalidated, as before', () => {
    expect(selectValidator(item('int x;', { path: 'a.cpp' }))).toBeNull();
  });
});
```

Add `createContextItem`, `selectValidator` and `validateItemAst` to the imports if absent. Append
to `test/unit/validator-guarantee.test.ts`:

```ts
describe('the C and C# validators check balance, not syntax (R4)', () => {
  it.each([
    ['c', 'a.c', 'int x = ;'],
    ['c', 'a.c', 'this is plain English prose, not C at all.'],
    ['csharp', 'A.cs', 'class { void ( ) { } }'],
    ['csharp', 'A.cs', 'this is plain English prose, not C# at all.'],
  ])('%s accepts balanced nonsense: %j', (language, path, content) => {
    const result = validateItemAst(item(content, language, path));
    expect(result.validated).toBe(true);
    expect(result.valid).toBe(true);
  });

  it.each([
    ['c', 'a.c', 'int f(void) {'],
    ['csharp', 'A.cs', 'class A {'],
  ])('%s rejects an unbalanced bracket, which is the guarantee it does make', (language, path, content) => {
    expect(validateItemAst(item(content, language, path)).valid).toBe(false);
  });
});
```

(`item(content, language, path)` is that file's existing helper at line 23.) In
`test/unit/language-support.test.ts`, add a C# row to `cases`:

```ts
    ['csharp', 'x.cs', JS_BODY, false],
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/validator-coverage.test.ts test/unit/validator-guarantee.test.ts test/unit/language-support.test.ts`
Expected: the coverage and guarantee cases FAIL, because `selectValidator` returns `null`. The
language-support row passes already, which makes it a negative control.

- [ ] **Step 3: Implement** in `src/core/validation/ast/index.ts`

```ts
import { CValidator } from './c-validator';
import { CSharpValidator } from './csharp-validator';
// …existing imports…
export * from './c-validator';
export * from './csharp-validator';

const cValidator = new CValidator();
const csharpValidator = new CSharpValidator();
```

In `selectFastValidator`, the `lang` block gains:

```ts
    // C and C# (R4, spec §4.1). `h` is accepted for the same parity reason `LANGUAGE_ALIASES`
    // records: an undeclared item can carry the raw extension spelling.
    if (lang === 'c' || lang === 'h') {
      return cValidator;
    }
    if (['csharp', 'cs', 'c#'].includes(lang)) {
      return csharpValidator;
    }
```

The `path` block gains:

```ts
    if (ext === 'c' || ext === 'h') {
      return cValidator;
    }
    if (ext === 'cs') {
      return csharpValidator;
    }
```

Extend the `CONTENT_TYPE_VALIDATORS.code` comment's last paragraph:

```ts
  // **C and C# joined in R4 (§84) the same way**, by declared language and by path, through
  // their own lexers — `code` still selects nothing.
```

- [ ] **Step 4: Run them, then the whole suite**

Run: `npx vitest run`
Expected: PASS. If a test pinned "C is unvalidated" (search `test/` for `'.c'` and
`validated: false`), update it to the new truth and name it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add src/core/validation/ast/index.ts test/unit/validator-coverage.test.ts test/unit/validator-guarantee.test.ts test/unit/language-support.test.ts
git commit -m "feat(validation): the Fast chain names C and C# (R4)" -m "Declared c/h and .c/.h select CValidator; csharp/cs/c# and .cs select CSharpValidator. This reaches Fast mode: .c/.h/.cs items go from validated:false to checked, so the false-positive census (§84) gates the PR." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The census and in-place manifest tools

**Files:**
- Create: `tools/corpus-harness/lexer-census.js`
- Create: `tools/corpus-harness/manifest-in-place.js`
- Modify: `tools/corpus-harness/collect.js`. Export `pinEngine`, `sha256` and `walk`, and guard
  `main()` with `require.main === module`.
- Modify: `tools/corpus-harness/README.md`, adding a short section for each tool.
- Test: `test/unit/corpus-harness-census.test.ts`

**Interfaces:**
- Produces: `lexer-census.js` exports `{ mutateLastCloser(content): string | null, EXTENSIONS }`
  and as a CLI writes `<out>/census-summary.json`, `<out>/flagged.jsonl` and `<out>/missed.jsonl`.
- Produces: `manifest-in-place.js` writes `<root>/manifest.json` in `measure.js`'s schema, with
  `{ bucket, corpusPath, source, bytes, sha256 }` per file plus `engine`.

- [ ] **Step 1: Write the failing test** `test/unit/corpus-harness-census.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const census = require(path.join(__dirname, '..', '..', 'tools', 'corpus-harness', 'lexer-census.js')) as {
  EXTENSIONS: Record<string, string[]>;
  mutateLastCloser(content: string): string | null;
};

describe('lexer census — the mutation control (§84)', () => {
  it('deletes the last line that is a closing brace alone', () => {
    expect(census.mutateLastCloser('int f(void) {\n  return 0;\n}\nint g(void) {\n}\n')).toBe(
      'int f(void) {\n  return 0;\n}\nint g(void) {\n',
    );
  });

  it('keeps a CRLF file CRLF', () => {
    expect(census.mutateLastCloser('class A\r\n{\r\n}\r\n')).toBe('class A\r\n{\r\n');
  });

  it('returns null when there is nothing to delete, so the file is not counted as caught', () => {
    expect(census.mutateLastCloser('int f(void) { return 0; }\n')).toBeNull();
  });

  it('covers exactly the two languages R4 adds', () => {
    expect(census.EXTENSIONS).toEqual({ c: ['.c', '.h'], csharp: ['.cs'] });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/corpus-harness-census.test.ts`
Expected: FAIL with `Cannot find module …lexer-census.js`.

- [ ] **Step 3: Implement**

At the bottom of `tools/corpus-harness/collect.js`, replace the bare `main();` call with:

```js
if (require.main === module) {
  main();
}

module.exports = { pinEngine, sha256, walk };
```

Create `tools/corpus-harness/lexer-census.js`:

```js
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
 * Refuses an empty file set (0 flags over 0 files reads like a pass) and refuses a file the Fast
 * chain does not route to the expected validator (design §3.8: assert classification first).
 * The mutation control deletes each file's last `}`-only line and requires the verdict to flip;
 * a file whose verdict does not flip is listed in `missed.jsonl` to be read and explained.
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
  const flagged = new Set(['--language', '--out', '--exclude']);
  const roots = argv.filter((a, i) => !a.startsWith('--') && !flagged.has(argv[i - 1]));
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
```

Create `tools/corpus-harness/manifest-in-place.js`:

```js
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
```

Before relying on it, confirm that `ceiling.js` exports `classify`, which the existing unit test
requires (`test/unit/corpus-harness-ceiling.test.ts` calls `ceiling.classify`). Confirm also that
requiring `ceiling.js` does not run its CLI: `node -e "require('./tools/corpus-harness/ceiling.js')"`
must print nothing and exit 0. If it runs `main`, guard it with `require.main === module`, as
above.

Append to `tools/corpus-harness/README.md`:

````markdown
## Lexer census (`lexer-census.js`)

A Fast lexer's verdict on every file of one or more checkouts, plus a mutation control — the
false-positive census DECISIONS §84 gates C and C# on. It lists **every** flagged file, because
the bar is "every flag read".

```bash
node tools/corpus-harness/lexer-census.js <root> [<root> ...] --language c --out <dir> [--exclude deps]
```

## In-place manifests (`manifest-in-place.js`)

Hashes a checkout where it stands and writes `measure.js`'s manifest into it, for trees whose
paths are too deep to flatten on Windows. `--classify` splits source from test and drops generated
files using `ceiling.js`'s rule. Weaker provenance than a `collect.js` pin; say so when quoting it.

```bash
node tools/corpus-harness/manifest-in-place.js <root> --bucket redis --ext c,h --exclude deps --classify
node tools/corpus-harness/measure.js <root> --variant deep --mode deep --routes file
```
````

(The `--mode deep` spelling in that example becomes correct in Task 15. Until then `measure.js`
takes `--engine-mode deep`.)

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/corpus-harness-census.test.ts test/unit/corpus-harness-ceiling.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/corpus-harness/lexer-census.js tools/corpus-harness/manifest-in-place.js tools/corpus-harness/collect.js tools/corpus-harness/README.md test/unit/corpus-harness-census.test.ts
git commit -m "feat(harness): a lexer census and in-place manifests (R4)" -m "lexer-census lists every flagged file and runs a delete-the-last-closer mutation control; manifest-in-place hashes a checkout where it stands for measure.js. collect.js exports pinEngine/sha256/walk." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Measure §84 — the lexers against at least 5,000 real files each

This task has no product code unless the census finds false positives. Fixes go back into Tasks
2–3's files, test first.

- [ ] **Step 1: Build and clone**

```bash
npm run build
mkdir -p "$CORPORA"
```

Clone each with `git -c core.autocrlf=false -c core.longpaths=true clone --filter=tree:0 --no-checkout <url> <dir>`,
then `git -C <dir> checkout <commit>`, then `git -C <dir> cat-file -t HEAD` (expect `commit`).

| dir | url | commit | language |
|---|---|---|---|
| `redis` | `https://github.com/redis/redis` | `7a72677e622d` (§82) | C |
| `curl` | `https://github.com/curl/curl` | `8807773c6af3` (§82) | C |
| `git` | `https://github.com/git/git` | HEAD at clone — record the SHA | C |
| `postgres` | `https://github.com/postgres/postgres` | HEAD at clone — record the SHA | C |
| `Newtonsoft.Json` | `https://github.com/JamesNK/Newtonsoft.Json` | `52fa3aef1f2c` (§82) | C# |
| `jellyfin` | `https://github.com/jellyfin/jellyfin` | `208c278b75ab` (§82) | C# |
| `PowerShell` | `https://github.com/PowerShell/PowerShell` | HEAD at clone — record the SHA | C# |
| `ILSpy` | `https://github.com/icsharpcode/ILSpy` | HEAD at clone — record the SHA | C# |

The local MSYS2 headers (`C:/msys64/ucrt64/include`, 2,806 eligible `.h` files and the source of
the main corpus's `c` bucket) are a fifth C tree.

- [ ] **Step 2: Run the census**

```bash
node tools/corpus-harness/lexer-census.js "$CORPORA/redis" "$CORPORA/curl" "$CORPORA/git" "$CORPORA/postgres/src" C:/msys64/ucrt64/include --language c --out "$CORPORA/census-c" --exclude deps
node tools/corpus-harness/lexer-census.js "$CORPORA/Newtonsoft.Json/Src" "$CORPORA/jellyfin" "$CORPORA/PowerShell/src" "$CORPORA/ILSpy" --language csharp --out "$CORPORA/census-csharp"
```

Expected for each language: `files` ≥ 5,000. If either falls short, add a pinned tree and say
which. The candidates are `sqlite` or `FFmpeg` for C, and `dotnet/aspnetcore src/` for C#.

- [ ] **Step 3: Read every flagged file**

For each row of `flagged.jsonl`, open the file at the reported line and classify the flag:

- **TP**, a true positive: the file really is unbalanced — malformed test data, a fragment, or a
  file meant to be `#include`d mid-construct.
- **FP**, a false positive: valid code the lexer misreads.

For every FP, add a failing known-answer case to `c-validator.test.ts` or
`csharp-validator.test.ts`, fix the lexer, rebuild and re-run the census. Repeat until the FP
count is ≤ 0.1% of `files`. **Do not change the bar.** If it cannot be met, stop: the language
does not ship. Record that outcome and drop the language from Tasks 7–12.

- [ ] **Step 4: Read every mutation miss**

Each row of `missed.jsonl` must be explained, typically by a `}` line inside a raw string, a
comment, or an inactive branch. Expected `catchRate` is ≥ 0.95.

- [ ] **Step 5: Fast-mode control on the main corpus**

Freeze the corpus, then build the baseline in a throwaway worktree at `fa9edc9` (main after
#80, so it has §83 and nothing of R4). Copy its `dist/` out, and swap `dist/` in this worktree
between the two arms:

```bash
node tools/corpus-harness/collect.js "$CORPORA/main"
git worktree add "$CORPORA/wt-baseline" fa9edc9
(cd "$CORPORA/wt-baseline" && npm ci --ignore-scripts && npm run build)
cp -r "$CORPORA/wt-baseline/dist" "$CORPORA/dist-baseline"
npm run build && cp -r dist "$CORPORA/dist-candidate"
```

Put `dist-baseline` in place as `dist/` for the first run, then `dist-candidate` for the second,
and check which one is in place before each run. A failed build that leaves the previous `dist/`
behind compares an engine against itself; the `measure-corpus` skill names this trap. Run:

```bash
node tools/corpus-harness/measure.js "$CORPORA/main" --variant a6-baseline   # with dist-baseline in place
node tools/corpus-harness/measure.js "$CORPORA/main" --variant a6-candidate  # with this branch's dist
```

Diff per row on `outputSha`, `fallbackUsed` and `astChecked`, keyed by `corpusPath|route`, and
assert 594 rows on each side. Expected:

- **every `outputSha` and `fallbackUsed` identical**;
- `astChecked` 0 → 1 on exactly the `c` bucket's file-route rows, which are the 30 `.h` files.
  The stdin route stays unchecked, because a pathless C item has no language.

Any `fallbackUsed` change is a census miss: return to Step 3.

- [ ] **Step 6: Write DECISIONS §84 and the CHANGELOG entry, then commit**

Append `## 84. R4 Step 1: Two Lexers, And A Census That Read Every Flag` to `DECISIONS.md`,
following §60's structure. Record:

- the trees with full SHAs;
- files and bytes per language;
- flagged counts with each TP and FP by file and cause;
- every lexer fix the census forced;
- the mutation catch rate with each miss explained;
- the main-corpus control.

Close with a "What this does not establish" list, which must include:

- syntax: the lexers check balance only;
- any C++ beyond raw strings;
- the `#if` expressions the lexers do not evaluate.

Under `## [Unreleased]` → `### Changed` in `CHANGELOG.md`, add an entry headed **"C and C# are
validated (DECISIONS §84)"**. Say that this reaches Fast mode — `.c`/`.h`/`.cs` items are now
checked — and give the census figures.

```bash
git add DECISIONS.md CHANGELOG.md src test
git commit -m "docs: R4 step 1 measured — the C and C# lexers (§84)" -m "<census figures>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `tokendamper-deep` learns C and C#

**Files:**
- Modify: `packages/deep/package.json`. Run
  `npm install tree-sitter-c@0.24.1 tree-sitter-c-sharp@0.23.5 -w tokendamper-deep --ignore-scripts`
  **from this worktree's root**; that also updates `package-lock.json`.
- Modify: `packages/deep/src/grammars.ts` (union, list, `WASM_SPECIFIERS`).
- Create: `packages/deep/src/cfamily.ts` (regions, symbols and definition spans for C and C#).
- Modify: `packages/deep/src/regions.ts` (C and C# cases plus the exhaustiveness guard).
- Modify: `packages/deep/src/index.ts` (route `symbols()`; expose `definitions()` on `DeepBackend`).
- Test: `test/unit/deep-backend-cfamily.test.ts`

**Interfaces:**
- Produces: `DeepLanguage` includes `'c' | 'csharp'`.
- Produces: `cFamilyRegions(root, language)`, `cFamilySymbols(root, language)` and
  `cFamilyDefinitions(root, language)`, the last returning
  `Array<{ symbol: string; start: number; end: number }>`.
- Produces: `DeepBackend.definitions(content)`, which the Task 9 control tool uses.
- Symbol vocabulary for C is `fn:<name>`. For C# it is
  - `method:<Type>.<name>` for methods and constructors,
  - `method:<Type>.~<name>` for destructors,
  - `method:<Type>.operator<op>` and `method:<Type>.operator <type>` for operators,
  - `method:<Type>.<Prop>.<get|set|init|add|remove>` for accessors,
  - `fn:<name>` for local functions.

  Symbols are harvested **only for declarations whose body is a block**, the same set `regions()`
  considers.

- [ ] **Step 1: Install the grammars and confirm the wasm resolves**

```bash
npm install tree-sitter-c@0.24.1 tree-sitter-c-sharp@0.23.5 -w tokendamper-deep --ignore-scripts
node -e "console.log(require.resolve('tree-sitter-c/tree-sitter-c.wasm', {paths:['packages/deep/src']}), require.resolve('tree-sitter-c-sharp/tree-sitter-c_sharp.wasm', {paths:['packages/deep/src']}))"
git status --short   # expect: package.json, package-lock.json, packages/deep/package.json only
```

- [ ] **Step 2: Write the failing test** `test/unit/deep-backend-cfamily.test.ts`

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { createDeepBackends, type DeepBackend } from '../../packages/deep/src/index';

/**
 * R4 — C and C# in the Deep backend (spec §4.3–§4.4). Every case fails against the unfixed
 * package, which has no `c` or `csharp` backend. Regions here are what `regions()` *offers*;
 * nothing in core can reach them until Task 10 opens the gate.
 */
let c: DeepBackend;
let cs: DeepBackend;
const MARKER = '[TokenDamper: 3 function body lines elided, 90 bytes, sha256:0123456789ab]';

beforeAll(async () => {
  const all = new Map((await createDeepBackends()).map((b) => [b.language, b]));
  c = all.get('c')!;
  cs = all.get('csharp')!;
});

const C_SRC = [
  'static int *alloc(size_t n) {',
  '  return malloc(n);',
  '}',
  'int proto(int);',
  'struct P { int x; };',
  'int main(void)',
  '{',
  '  return 0;',
  '}',
  '',
].join('\n');

const CS_SRC = [
  'namespace N {',
  '  class Foo {',
  '    public Foo(int a) { x = a; }',
  '    ~Foo() { }',
  '    public int Bar(int x) { int Loc() { return 1; } return Loc(); }',
  '    int Expr() => 42;',
  '    public abstract void Abs();',
  '    public static Foo operator +(Foo a, Foo b) { return a; }',
  '    public int P { get { return 1; } set { } }',
  '    Func<int,int> f = x => { return x; };',
  '  }',
  '  interface I { void M(); }',
  '}',
  '',
].join('\n');

describe('C', () => {
  it('names every function definition and no prototype', () => {
    expect([...c.symbols(C_SRC)].sort()).toEqual(['fn:alloc', 'fn:main']);
  });

  it('offers each body interior, in the brace convention every backend uses', () => {
    const bodies = c.regions(C_SRC).map((r) => C_SRC.slice(r.start, r.end).trim());
    expect(bodies).toEqual(['return malloc(n);', 'return 0;']);
  });

  it('still names a function whose body TokenDamper has elided', () => {
    expect([...c.symbols(`int a(void) {${MARKER}}\nint b(void) { return 1; }\n`)].sort()).toEqual(['fn:a', 'fn:b']);
  });

  it('spans each whole definition, header included, for the deletion control', () => {
    const defs = c.definitions(C_SRC);
    expect(defs.map((d) => d.symbol)).toEqual(['fn:alloc', 'fn:main']);
    expect(C_SRC.slice(defs[0]!.start, defs[0]!.end)).toBe('static int *alloc(size_t n) {\n  return malloc(n);\n}');
  });
});

describe('C#', () => {
  it('names block-bodied members, qualified by their type, and nothing bodiless', () => {
    expect([...cs.symbols(CS_SRC)].sort()).toEqual([
      'fn:Loc',
      'method:Foo.Bar',
      'method:Foo.Foo',
      'method:Foo.P.get',
      'method:Foo.P.set',
      'method:Foo.operator+',
      'method:Foo.~Foo',
    ]);
  });

  it('offers block bodies, lambdas included, and no expression body', () => {
    const bodies = cs.regions(CS_SRC).map((r) => CS_SRC.slice(r.start, r.end).trim());
    expect(bodies).toContain('return x;');
    expect(bodies).toContain('return a;');
    expect(bodies.some((b) => b.includes('42'))).toBe(false);
  });

  it('still names a member whose body TokenDamper has elided', () => {
    const src = `class K {\n  public int A(int x) {${MARKER}}\n  void Z() { }\n}\n`;
    expect([...cs.symbols(src)].sort()).toEqual(['method:K.A', 'method:K.Z']);
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run test/unit/deep-backend-cfamily.test.ts`
Expected: FAIL. There are no `c`/`csharp` backends, and `c` is `undefined`.

- [ ] **Step 4: Implement**

`packages/deep/src/grammars.ts`:

```ts
export type DeepLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'c' | 'csharp';

export const DEEP_LANGUAGES: ReadonlyArray<DeepLanguage> = Object.freeze([
  'typescript',
  'javascript',
  'python',
  'go',
  // R4 (DECISIONS §84–§86): deep-only languages — core has no Fast region scanner for either.
  'c',
  'csharp',
]);

const WASM_SPECIFIERS: Readonly<Record<DeepLanguage, string>> = Object.freeze({
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  c: 'tree-sitter-c/tree-sitter-c.wasm',
  csharp: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
});
```

Update the module doc comment's first paragraph:

```ts
/**
 * Which grammar answers for which language, and where its WASM lives.
 *
 * The first four are the four the shipped Fast path identifies (R3). C and C# are R4's: §82
 * measured them above the 40% floor on two corpora each, and they are **deep-only** — core
 * names them through its Fast lexers but has no region scanner for either.
 */
```

Create `packages/deep/src/cfamily.ts`:

```ts
import type { Node } from 'web-tree-sitter';

import type { DeepRegion } from './regions';

/**
 * C and C# for the Deep backend (R4, spec §4.3–§4.4, DECISIONS §85–§86).
 *
 * **One rule decides both symbols and regions: a declaration whose body is a `{ … }` block.**
 * Regions are those blocks' interiors. Symbols are those declarations' names, and nothing else —
 * not prototypes, not abstract or interface members, not expression-bodied members, and not
 * types, which the shared regex already harvests. A symbol for a declaration elision cannot touch
 * would survive every transform by construction, raising `R_AST` and lowering `S_k` for the same
 * loss. That is §59's falling drift score, the hazard this package was built to avoid.
 *
 * The node tables are §82's, which passed 44 known-answer fixtures before any corpus was measured.
 */

export type CFamilyLanguage = 'c' | 'csharp';

const C_FUNCTION_NODES: ReadonlySet<string> = new Set(['function_definition']);

const CSHARP_FUNCTION_NODES: ReadonlySet<string> = new Set([
  'method_declaration',
  'constructor_declaration',
  'destructor_declaration',
  'operator_declaration',
  'conversion_operator_declaration',
  'local_function_statement',
  'accessor_declaration',
  'lambda_expression',
  'anonymous_method_expression',
]);

const CSHARP_TYPE_NODES: ReadonlySet<string> = new Set([
  'class_declaration',
  'struct_declaration',
  'record_declaration',
  'interface_declaration',
]);

function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** The block body of a function-like node, or null when it has none (`;`, `=> expr`). */
function blockBody(node: Node, language: CFamilyLanguage): Node | null {
  const braceType = language === 'c' ? 'compound_statement' : 'block';
  const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === braceType) ?? null;
  return body && body.type === braceType ? body : null;
}

function functionNodes(language: CFamilyLanguage): ReadonlySet<string> {
  return language === 'c' ? C_FUNCTION_NODES : CSHARP_FUNCTION_NODES;
}

/** A C function definition's name, through pointer and attributed declarators. */
function cFunctionName(definition: Node): string | null {
  let declarator = definition.childForFieldName('declarator');
  while (declarator && declarator.type !== 'function_declarator') {
    declarator = declarator.childForFieldName('declarator');
  }
  const name = declarator?.childForFieldName('declarator');
  return name && (name.type === 'identifier' || name.type === 'field_identifier') ? name.text : null;
}

/** The innermost enclosing C# type's name, or '' at top level. */
function enclosingType(node: Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (CSHARP_TYPE_NODES.has(parent.type)) return parent.childForFieldName('name')?.text ?? '';
  }
  return '';
}

/** The symbol a block-bodied declaration contributes, or null for an anonymous one. */
function symbolFor(node: Node, language: CFamilyLanguage): string | null {
  if (language === 'c') {
    const name = cFunctionName(node);
    return name ? `fn:${name}` : null;
  }
  const owner = enclosingType(node);
  const member = (text: string) => `method:${owner ? `${owner}.` : ''}${text}`;
  const name = node.childForFieldName('name')?.text;
  switch (node.type) {
    case 'method_declaration':
    case 'constructor_declaration':
      return name ? member(name) : null;
    case 'destructor_declaration':
      return name ? member(`~${name}`) : null;
    case 'operator_declaration': {
      const op = node.childForFieldName('operator');
      return op ? member(`operator${op.text}`) : null;
    }
    case 'conversion_operator_declaration': {
      const type = node.childForFieldName('type');
      return type ? member(`operator ${type.text}`) : null;
    }
    case 'local_function_statement':
      return name ? `fn:${name}` : null;
    case 'accessor_declaration': {
      // accessor_declaration -> accessor_list -> property/indexer/event declaration
      const owner2 = node.parent?.parent;
      const property = owner2?.childForFieldName('name')?.text ?? (owner2?.type === 'indexer_declaration' ? 'this[]' : null);
      return property && name ? member(`${property}.${name}`) : null;
    }
    default:
      return null; // lambda_expression, anonymous_method_expression: no name to take
  }
}

export function cFamilyRegions(root: Node, language: CFamilyLanguage): DeepRegion[] {
  const regions: DeepRegion[] = [];
  const kinds = functionNodes(language);
  walk(root, (node) => {
    if (!kinds.has(node.type)) return;
    const body = blockBody(node, language);
    if (!body) return;
    const start = body.startIndex + 1;
    const end = body.endIndex - 1;
    if (end > start) regions.push({ start, end });
  });
  return regions;
}

export function cFamilySymbols(root: Node, language: CFamilyLanguage): Set<string> {
  const symbols = new Set<string>();
  for (const definition of cFamilyDefinitions(root, language)) symbols.add(definition.symbol);
  return symbols;
}

/** Each named block-bodied declaration with its whole span, header included. Tooling (§85). */
export function cFamilyDefinitions(
  root: Node,
  language: CFamilyLanguage,
): Array<{ symbol: string; start: number; end: number }> {
  const out: Array<{ symbol: string; start: number; end: number }> = [];
  const kinds = functionNodes(language);
  walk(root, (node) => {
    if (!kinds.has(node.type) || !blockBody(node, language)) return;
    const symbol = symbolFor(node, language);
    if (symbol) out.push({ symbol, start: node.startIndex, end: node.endIndex });
  });
  return out.sort((a, b) => a.start - b.start);
}
```

In `packages/deep/src/regions.ts`, import and route, and add the guard:

```ts
import { cFamilyRegions } from './cfamily';

/** Converts a parse tree into candidate elision spans. Pure. */
export function regionsFromTree(
  tree: Tree,
  language: DeepLanguage,
  options: DeepRegionOptions = {},
): DeepRegion[] {
  const root = tree.rootNode;
  switch (language) {
    case 'typescript':
    case 'javascript':
      return typescriptRegions(root);
    case 'go':
      return goRegions(root);
    case 'python':
      return pythonRegions(root, tree, options);
    case 'c':
    case 'csharp':
      return cFamilyRegions(root, language);
    default: {
      // The deferred R3 review item, closed in the release that needed it: a language missing
      // here used to return [] silently, which reads as `backendAnswered > 0` with zero regions.
      const unreachable: never = language;
      throw new Error(`tokendamper-deep: no region table for ${String(unreachable)}`);
    }
  }
}
```

In `packages/deep/src/index.ts`:

```ts
import { cFamilyDefinitions, cFamilySymbols } from './cfamily';
```

Extend `DeepBackend`:

```ts
export interface DeepBackend {
  readonly name: string;
  readonly language: DeepLanguage;
  symbols(content: string): Set<string>;
  check(content: string): DeepCheckResult;
  regions(content: string, options?: DeepRegionOptions): DeepRegion[];
  /**
   * Each named block-bodied declaration's whole span. C and C# only — empty for the R3
   * languages, whose symbols mirror the shipped regex rather than a declaration list. Used by the
   * §85 deletion control; never by core.
   */
  definitions(content: string): Array<{ symbol: string; start: number; end: number }>;
}
```

Inside `createBackend`'s returned object, replace `symbols` and add `definitions`:

```ts
    symbols(content: string): Set<string> {
      const tree = parser.parse(content);
      if (tree === null) return new Set();
      try {
        return language === 'c' || language === 'csharp'
          ? cFamilySymbols(tree.rootNode, language)
          : symbolsFromTree(tree, language);
      } finally {
        // web-tree-sitter trees hold WASM memory that GC does not reclaim.
        tree.delete();
      }
    },
    definitions(content: string): Array<{ symbol: string; start: number; end: number }> {
      if (language !== 'c' && language !== 'csharp') return [];
      const tree = parser.parse(content);
      if (tree === null) return [];
      try {
        return cFamilyDefinitions(tree.rootNode, language);
      } finally {
        tree.delete();
      }
    },
```

- [ ] **Step 5: Run the new tests and the deep suites**

Run: `npx vitest run test/unit/deep-backend-cfamily.test.ts test/unit/deep-backend-symbols.test.ts test/unit/deep-backend-regions.test.ts test/unit/deep-backend-validator.test.ts`
Expected: PASS.

If an existing deep suite asserts the backend list is exactly four languages, update it to six
and say so in the commit. `src/cli/deep-backends.ts` registers every backend except `javascript`,
so `c` and `csharp` register automatically. No CLI change is needed.

- [ ] **Step 6: Typecheck the package, run the full suite, commit**

```bash
npx tsc -p packages/deep/tsconfig.json --noEmit && npm run typecheck && npm run lint && npx vitest run
git add packages/deep package.json package-lock.json test/unit/deep-backend-cfamily.test.ts
git commit -m "feat(deep): C and C# backends — symbols, regions, definitions (R4)" -m "One rule for both: a declaration whose body is a block. Symbols are those names only (no prototypes, abstract members, expression bodies or types). regionsFromTree gains the exhaustiveness guard. Core cannot reach C/C# regions yet." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The drift gate takes C and C# symbols from the backend, in Deep mode only

**Files:**
- Create: `src/core/parser/deep-only.ts`
- Modify: `src/core/ledger/drift-tracker.ts`. Add `DriftTrackerOptions.engineMode`, store it,
  and add a final block in `extractItemSymbols`.
- Modify: `src/core/validation/index.ts:125-126`, passing the engine mode to `DriftTracker`.
- Modify: `src/stages/compression/token-hashing.ts:27-30` and the call at `:256`, passing the
  stage mode to the probe.
- Test: `test/unit/drift-deep-only-symbols.test.ts`

**Interfaces:**
- Produces: `DEEP_ONLY_LANGUAGES: ReadonlyArray<'c' | 'csharp'>`,
  `isDeepOnlyLanguage(language: string | undefined): boolean` and
  `deepOnlyBackend(item: ContextItem, mode: EngineMode): ParserAdapter | undefined`.
- Produces: `new DriftTracker({ engineMode?: EngineMode })`.

- [ ] **Step 1: Write the failing test** `test/unit/drift-deep-only-symbols.test.ts`

```ts
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDeepBackends } from '../../packages/deep/src/index';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createContextItem } from '../../src/core/model/constructors';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import { deepOnlyBackend, isDeepOnlyLanguage } from '../../src/core/parser/deep-only';
import type { ParserAdapter } from '../../src/core/parser/types';

/**
 * R4 step 2 (spec §4.3, DECISIONS §85). C and C# take function symbols from their backend, in
 * Deep mode only. Every assertion that a symbol appears fails against the unfixed engine; the
 * "does not move" cases are negative controls and pass on both.
 */
let backends: ParserAdapter[];
beforeAll(async () => {
  backends = (await createDeepBackends()) as unknown as ParserAdapter[];
});
afterEach(() => clearParserBackends());
const register = () => backends.filter((b) => b.language !== 'javascript').forEach(registerParserBackend);

const C = 'struct P { int x; };\nint area(struct P p) {\n  return p.x * p.x;\n}\n';
const cItem = createContextItem({ id: 'c', kind: 'file', content: C, contentType: 'code', path: 'a.c' });

describe('deepOnlyBackend', () => {
  it('names exactly C and C#', () => {
    expect(['c', 'csharp', 'go', 'typescript', undefined].map(isDeepOnlyLanguage)).toEqual([true, true, false, false, false]);
  });

  it('answers only in deep mode, and only once a backend is registered', () => {
    expect(deepOnlyBackend(cItem, 'deep')).toBeUndefined();
    register();
    expect(deepOnlyBackend(cItem, 'fast')).toBeUndefined();
    expect(deepOnlyBackend(cItem, 'deep')?.language).toBe('c');
  });
});

describe('drift symbols for C', () => {
  it('fast mode sees only the incidental type symbol — the §56 hazard, recorded', () => {
    register();
    expect([...new DriftTracker().extractItemSymbols(cItem)].sort()).toEqual(['type:P']);
  });

  it('deep mode adds the function, so deleting it is witnessed', () => {
    register();
    const deep = new DriftTracker({ engineMode: 'deep' });
    expect([...deep.extractItemSymbols(cItem)].sort()).toEqual(['fn:area', 'type:P']);

    const deleted = createContextItem({ ...cItem, content: 'struct P { int x; };\n' });
    const report = deep.calculateDrift({ items: [cItem] } as never, { items: [deleted] } as never);
    expect(report.driftScore).toBeGreaterThan(0);
  });

  it('does not move TypeScript, Python or Go in deep mode', () => {
    register();
    const ts = createContextItem({ id: 't', kind: 'file', content: 'export function a(){ return 1; }\n', contentType: 'code', path: 'a.ts' });
    expect(new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(ts)).toEqual(new DriftTracker().extractItemSymbols(ts));
  });
});
```

If `calculateDrift` needs fuller bundles than `{ items }`, build them with `createContextBundle`
from `constructors`, the way `test/unit/drift-tracker.test.ts` does. Use whichever shape that file
uses.

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/drift-deep-only-symbols.test.ts`
Expected: FAIL. `deep-only` does not exist.

- [ ] **Step 3: Implement**

`src/core/parser/deep-only.ts`:

```ts
import type { ContextItem } from '../model/types';
import { selectValidator } from '../validation/ast';
import { resolveParserBackend } from './registry';
import type { EngineMode, ParserAdapter } from './types';

/**
 * Languages whose function bodies only a Deep backend can find (R4, spec §2).
 *
 * Core names them through its Fast lexers, which is what makes them reachable at all (§81's
 * JavaScript lesson), but has no region scanner for either. **Every rule that treats them
 * differently asks this module**, so the region gate (`regionElisionLanguage`), the drift gate's
 * symbols (`DriftTracker`) and the language-support report cannot disagree about which items are
 * deep-only.
 */
export const DEEP_ONLY_LANGUAGES: ReadonlyArray<'c' | 'csharp'> = Object.freeze(['c', 'csharp']);

export function isDeepOnlyLanguage(language: string | undefined): boolean {
  return language !== undefined && (DEEP_ONLY_LANGUAGES as ReadonlyArray<string>).includes(language);
}

/** The backend answering for a deep-only item in deep mode; `undefined` otherwise. */
export function deepOnlyBackend(item: ContextItem, mode: EngineMode): ParserAdapter | undefined {
  if (mode !== 'deep') return undefined;
  const language = selectValidator(item, 'fast')?.language;
  return isDeepOnlyLanguage(language) ? resolveParserBackend(language!) : undefined;
}
```

In `src/core/ledger/drift-tracker.ts`:

```ts
import { deepOnlyBackend } from '../parser/deep-only';
import { DEFAULT_ENGINE_MODE, type EngineMode } from '../parser/mode';
```

```ts
export interface DriftTrackerOptions {
  readonly maxDriftThreshold?: number | undefined; // Default: 0.40
  readonly weightAst?: number | undefined; // Default: 0.60
  readonly weightStruct?: number | undefined; // Default: 0.40
  /**
   * The engine (region) mode, not the validation mode: symbols must witness the regions that
   * mode can elide. Only deep-only languages read it (§85).
   */
  readonly engineMode?: EngineMode | undefined;
}
```

Add `private readonly engineMode: EngineMode;` to the class fields, and in the constructor:

```ts
    this.engineMode = options.engineMode ?? DEFAULT_ENGINE_MODE;
```

In `extractItemSymbols`, immediately before `return symbols;`:

```ts
    // 10. C and C# (R4, DECISIONS §85). Their function symbols come from their Deep backend,
    // because no regex above can harvest a C function or most C# methods — so before this, a C
    // file's only symbols were incidental `type:` matches that survive body elision by
    // construction, which is §56's unmeasured-elision hazard exactly. Deep mode only, and deep-only
    // languages only: TypeScript, Python and Go keep their regexes in both modes, so no existing
    // drift score moves. Whether Deep's symbols should replace those regexes is §79's open
    // question and stays open.
    const backend = deepOnlyBackend(item, this.engineMode);
    if (backend) {
      for (const symbol of backend.symbols(content)) symbols.add(symbol);
    }
```

In `src/core/validation/index.ts`, replace the two lines constructing the tracker:

```ts
  const driftTrackerOptions = {
    ...(options?.maxDriftThreshold !== undefined ? { maxDriftThreshold: options.maxDriftThreshold } : {}),
    // The region mode, because the symbols must witness what that mode can elide (§85).
    engineMode: options?.coverageMode ?? options?.mode ?? DEFAULT_ENGINE_MODE,
  };
  const driftTracker = new DriftTracker(driftTrackerOptions);
```

Import `DEFAULT_ENGINE_MODE` if it is not already imported there. In
`src/stages/compression/token-hashing.ts`:

```ts
function hasExtractableSymbols(item: ContextItem, mode: EngineMode): boolean {
  const probe = { items: [item] } as unknown as ContextBundle;
  return new DriftTracker({ engineMode: mode }).extractSymbols(probe).size > 0;
}
```

At its call site (line 256):

```ts
    if (hasExtractableSymbols(item, options?.mode ?? 'fast')) {
```

- [ ] **Step 4: Run the test, the full suite, typecheck and lint**

Run: `npx vitest run test/unit/drift-deep-only-symbols.test.ts && npx vitest run && npm run typecheck && npm run lint`
Expected: PASS. If lint flags `core/ledger → core/parser`, it should not: both are under
`src/core`. The restricted imports are only `adapters/`, `cli/` and `gateway/`.

- [ ] **Step 5: Commit**

```bash
git add src/core/parser/deep-only.ts src/core/ledger/drift-tracker.ts src/core/validation/index.ts src/stages/compression/token-hashing.ts test/unit/drift-deep-only-symbols.test.ts
git commit -m "feat(drift): C and C# take function symbols from their backend in deep mode (R4)" -m "deepOnlyBackend is the one place that decides; DriftTracker reads the engine (region) mode. TypeScript, Python and Go are unchanged in both modes. Still no region is reachable." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Measure §85 — deleting functions is witnessed, and nothing reduces yet

**Files:**
- Create: `tools/corpus-harness/function-deletion-control.js`
- Modify: `tools/corpus-harness/README.md` (a short section)

- [ ] **Step 1: Write the tool**

```js
#!/usr/bin/env node
'use strict';

/**
 * R4 step 2 (spec §4.3, DECISIONS §85) — the hand-elided control.
 *
 * Usage:
 *   node tools/corpus-harness/function-deletion-control.js <root> [...] --language c|csharp --out <dir> [--exclude a,b]
 *
 * For each file, every named block-bodied declaration is deleted whole — header and body — and the
 * drift gate scores before against after in deep mode. **`S_k` must be non-zero on every file
 * that lost a function.** §59's version of this control on Go is how the step-1 hazard was found:
 * a file with every function deleted scored `S_k = 0.0000` with `astMeasured: true`. The fast-mode
 * score is recorded beside it, because it is the hazard this step closes.
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
    } else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(p);
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
    console.error('usage: function-deletion-control.js <root> [...] --language c|csharp --out <dir>');
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
  let withFunctions = 0;
  let witnessed = 0;
  let fastZero = 0;
  const violations = [];

  for (const abs of files) {
    const content = fs.readFileSync(abs, 'utf8');
    const defs = backend.definitions(content);
    if (defs.length === 0) continue;
    withFunctions += 1;
    // Delete back to front so earlier offsets stay valid; skip nested spans already removed.
    let after = content;
    let lastStart = Infinity;
    for (const d of [...defs].sort((a, b) => b.start - a.start)) {
      if (d.end > lastStart) continue;
      after = after.slice(0, d.start) + after.slice(d.end);
      lastStart = d.start;
    }
    const before = createContextBundle(content, 'file', abs);
    const afterBundle = createContextBundle(after, 'file', abs);
    const ids = { items: afterBundle.items.map((it, k) => ({ ...it, id: before.items[k].id })) };
    const d = deep.calculateDrift(before, { ...afterBundle, ...ids });
    const f = fast.calculateDrift(before, { ...afterBundle, ...ids });
    const row = { file: abs, functions: defs.length, deepScore: d.driftScore, deepMeasured: d.measured, fastScore: f.driftScore, fastMeasured: f.measured };
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
  const summary = { language, files: files.length, withFunctions, witnessed, violations: violations.length, fastZeroScore: fastZero };
  fs.writeFileSync(path.join(outDir, 'deletion-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'deletion-rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (violations.length > 0) process.exit(1);
}

main();
```

- [ ] **Step 2: Build both packages and run the control on the four region corpora**

```bash
npm run build && npx tsc -p packages/deep/tsconfig.json
node tools/corpus-harness/function-deletion-control.js "$CORPORA/redis" "$CORPORA/curl" --language c --out "$CORPORA/deletion-c" --exclude deps
node tools/corpus-harness/function-deletion-control.js "$CORPORA/Newtonsoft.Json/Src" "$CORPORA/jellyfin" --language csharp --out "$CORPORA/deletion-csharp"
```

Expected: `violations: 0` for both. `fastZeroScore` is the count of files where Fast mode
witnessed nothing; record it as the hazard closed. A violation means a file lost functions and
drift stayed at 0: read it and fix the symbol table (Task 7), test first.

- [ ] **Step 3: Confirm nothing reduces, in either mode**

```bash
node tools/corpus-harness/manifest-in-place.js "$CORPORA/redis" --bucket redis --ext c,h --exclude deps --classify
node tools/corpus-harness/measure.js "$CORPORA/redis" --variant a9-deep --engine-mode deep --routes file
```

Expected: every row `byteIdentical: true`, with reduction 0. Re-run `measure.js` on
`$CORPORA/main` in both modes against the A6 candidate. Every `outputSha` must be identical; in
deep mode `driftScore` may change on the `c` bucket only.

- [ ] **Step 4: Write DECISIONS §85, the CHANGELOG entry and the README section, then commit**

`## 85. R4 Step 2: Backend Symbols Witness C And C# Function Loss`. Record:

- the deviation from the skill's order (spec §3) and why it is safe;
- the deletion-control figures per corpus, including `fastZeroScore` as the hazard closed;
- reduction 0;
- the main-corpus identity.

The "What this does not establish" list must include:

- overloads collapse into one `method:` symbol;
- types are deliberately not harvested.

```bash
git add tools/corpus-harness/function-deletion-control.js tools/corpus-harness/README.md DECISIONS.md CHANGELOG.md
git commit -m "docs: R4 step 2 measured — backend symbols witness function loss (§85)" -m "<figures>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The region gate opens for C and C#, in Deep mode only

**Files:**
- Modify: `src/core/elision/regions.ts`. Extend `RegionElisionLanguage` and
  `REGION_ELISION_LANGUAGES` (≈1161), the `regionElisionLanguage` gate (≈1182),
  `selectElisionRegions` (a guard after `backend` is resolved), `splitRegionIntoStatements`
  (≈639–662) and the `isSubstantiveRegion` doc comment.
- Modify: `src/stages/compression/token-hashing.ts`. `trimRegionsToCeiling` takes the mode, and
  its call passes `options?.mode`.
- Modify: `src/core/validation/language-support.ts`. `isElisionReducible(item, mode)`,
  `describeLanguageSupport(bundle, mode)` and the reason text.
- Modify: `src/core/validation/index.ts`, passing the mode to `describeLanguageSupport`.
- Test: `test/unit/elision-regions-mode.test.ts` and `test/unit/language-support.test.ts`
  (append to both).

**Interfaces:**
- Consumes: `isDeepOnlyLanguage` and `deepOnlyBackend` (Task 8); C and C# `regions()` (Task 7).
- Produces: `RegionElisionLanguage = 'typescript' | 'python' | 'go' | 'c' | 'csharp'`,
  `describeLanguageSupport(bundle, mode = DEFAULT_ENGINE_MODE)` and
  `isElisionReducible(item, mode = DEFAULT_ENGINE_MODE)`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/elision-regions-mode.test.ts`. If it lacks a backend-registration helper,
copy the `beforeAll`/`register`/`afterEach` block from Task 8's test.

```ts
describe('C and C# regions are deep-only (R4, spec §4.4)', () => {
  const C = 'int area(int w, int h) {\n' + '  int total = w * h;\n'.repeat(8) + '  return total;\n}\n';
  const cItem = createContextItem({ id: 'c', kind: 'file', content: C, contentType: 'code', path: 'a.c' });

  it('selects nothing in fast mode, and never reaches the TypeScript scanner', () => {
    register();
    expect(selectElisionRegions(cItem)).toEqual([]);
    expect(supportsRegionElision(cItem, 'fast')).toBe(false);
  });

  it('selects nothing in deep mode until a backend is registered', () => {
    expect(selectElisionRegions(cItem, { mode: 'deep' })).toEqual([]);
  });

  it('selects the body in deep mode with the backend registered', () => {
    register();
    const regions = selectElisionRegions(cItem, { mode: 'deep' });
    expect(regions).toHaveLength(1);
    expect(C.slice(regions[0]!.start, regions[0]!.end)).toContain('return total;');
  });

  it('divides a C body into statements under a ceiling, in deep mode', () => {
    register();
    const [region] = selectElisionRegions(cItem, { mode: 'deep' });
    expect(splitRegionIntoStatements(cItem, region!, { mode: 'deep' }).length).toBeGreaterThan(1);
    expect(splitRegionIntoStatements(cItem, region!)).toEqual([]);
  });
});
```

Append to `test/unit/language-support.test.ts`:

```ts
describe('C and C# report deep mode as the route (R4)', () => {
  it('names --engine-mode deep for a C file in fast mode', () => {
    const report = describeLanguageSupport(bundleFor('int f(void) { return 0; }\n', 'x.c', 'c'));
    expect(report.supported).toBe(0);
    expect(report.reason).toMatch(/C and C# reduce only under --engine-mode deep/);
  });

  it('counts a C file as supported in deep mode once the backend is registered', async () => {
    const { createDeepBackends } = await import('../../packages/deep/src/index');
    const { registerParserBackend, clearParserBackends } = await import('../../src/core/parser/registry');
    for (const b of await createDeepBackends()) if (b.language !== 'javascript') registerParserBackend(b as never);
    try {
      expect(describeLanguageSupport(bundleFor('int f(void) { return 0; }\n', 'x.c', 'c'), 'deep').supported).toBe(1);
    } finally {
      clearParserBackends();
    }
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/elision-regions-mode.test.ts test/unit/language-support.test.ts`
Expected: the deep-mode selection, division, reason and support cases FAIL. The fast-mode and
no-backend cases pass already, which makes them negative controls.

- [ ] **Step 3: Implement**

In `src/core/elision/regions.ts`:

```ts
import { isDeepOnlyLanguage } from '../parser/deep-only';
```

```ts
export type RegionElisionLanguage = 'typescript' | 'python' | 'go' | 'c' | 'csharp';

export const REGION_ELISION_LANGUAGES: ReadonlyArray<RegionElisionLanguage> = Object.freeze([
  'typescript',
  'python',
  'go',
  // C and C# (R4, DECISIONS §86) are deep-only: `regionElisionLanguage` returns them only when a
  // Deep backend answers. Steps 1 and 2 (§84 lexers, §85 backend symbols) landed first, so the
  // region step is last, which is §56's safety property.
  'c',
  'csharp',
]);
```

```ts
export function regionElisionLanguage(
  item: ContextItem,
  mode: EngineMode = DEFAULT_ENGINE_MODE,
): RegionElisionLanguage | undefined {
  const language = selectValidator(item, mode)?.language;
  if (language === undefined || !(REGION_ELISION_LANGUAGES as ReadonlyArray<string>).includes(language)) {
    return undefined;
  }
  // No Fast scanner exists for a deep-only language, so without a Deep backend there are no
  // regions to select, and it must never fall through to the TypeScript brace scanner.
  if (isDeepOnlyLanguage(language) && (mode !== 'deep' || resolveParserBackend(language) === undefined)) {
    return undefined;
  }
  return language as RegionElisionLanguage;
}
```

In `selectElisionRegions`, directly after `const backend = …`:

```ts
  if (backend === undefined && isDeepOnlyLanguage(language)) {
    // Unreachable through the gate above; kept so a deep-only language can never reach the
    // TypeScript scanner that is this function's last branch.
    return Object.freeze([]);
  }
```

In `splitRegionIntoStatements`, replace the language line and its comment:

```ts
  // The mode is honoured for the gate only, so C and C# — deep-only — can be divided under a
  // ceiling (R4, spec §4.4). For TypeScript, Python and Go the resolved name is the same in both
  // modes, so their splitter and output do not move. The *splitter* is still Fast's in every
  // mode, which is §81's note and stays true.
  const language = regionElisionLanguage(item, options?.mode);
```

The `spans` ternary already sends anything that is not `python` or `go` to
`splitTypeScriptStatements`. Add a comment saying C and C# use it because `;` ends their
statements too.

In the `isSubstantiveRegion` doc comment, add:

```ts
 * C and C# use the TypeScript stripper: `//` and `/* *\/` are their comment forms too, and §82's
 * instrument made the same choice (`stripAs: 'typescript'`).
```

In `src/stages/compression/token-hashing.ts`, add a final parameter to `trimRegionsToCeiling`:

```ts
  tokenizer: TokenizerAdapter,
  mode: EngineMode,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
```

The split inside it becomes:

```ts
    const statements = splitRegionIntoStatements(item, region, { mode });
```

At the call (≈line 204):

```ts
    const regions = trimRegionsToCeiling(item, allRegions, runningTokens, ceiling, priceMarker, tokenizer, options?.mode ?? 'fast');
```

In `src/core/validation/language-support.ts`:

```ts
import { isDeepOnlyLanguage } from '../parser/deep-only';
import { DEFAULT_ENGINE_MODE, type EngineMode } from '../parser/mode';
import { selectValidator } from './ast';

export function isElisionReducible(item: ContextItem, mode: EngineMode = DEFAULT_ENGINE_MODE): boolean {
  return supportsRegionElision(item, mode);
}

export function describeLanguageSupport(
  bundle: ContextBundle,
  mode: EngineMode = DEFAULT_ENGINE_MODE,
): LanguageSupportReport {
  const unsupportedLanguages = new Set<string>();
  let supported = 0;
  let unsupported = 0;
  let deepOnly = false;

  for (const item of bundle.items) {
    if (isElisionReducible(item, mode)) {
      supported += 1;
      continue;
    }
    unsupported += 1;
    unsupportedLanguages.add(item.language ?? item.contentType);
    if (isDeepOnlyLanguage(selectValidator(item, 'fast')?.language)) deepOnly = true;
  }

  const languages = [...unsupportedLanguages].sort();
  const noneSupported = bundle.items.length > 0 && supported === 0;
  const deepNote = deepOnly
    ? ' C and C# reduce only under --engine-mode deep, which needs the tokendamper-deep package.'
    : '';

  return {
    supported,
    unsupported,
    unsupportedLanguages: Object.freeze(languages),
    noneSupported,
    ...(unsupported === 0
      ? {}
      : {
          reason: noneSupported
            ? `Elision cannot reduce ${languages.join(', ')} in this build: there is no sub-item region selector for it, and whole-item elision cannot survive the drift gate. Fast mode reduces TypeScript/JavaScript, Python and Go, so 0% here is structural rather than a property of this input. Whole-item pruning is language-agnostic but needs a multi-item bundle.${deepNote}`
            : `${unsupported} of ${bundle.items.length} item(s) are in a language elision cannot reduce (${languages.join(', ')}); only whole-item pruning can affect them.${deepNote}`,
        }),
  };
}
```

In `src/core/validation/index.ts`:

```ts
  const languageSupport: LanguageSupportReport = describeLanguageSupport(
    before,
    options?.coverageMode ?? options?.mode ?? DEFAULT_ENGINE_MODE,
  );
```

- [ ] **Step 4: Run them, then the full suite, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS. Two kinds of existing test may need updating:

- a test pinning the old reason text ("TypeScript/JavaScript, Python and Go only"); update the
  regex to the new sentence;
- a test pinning `RegionElisionLanguage`'s membership.

Name each update in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/core/elision/regions.ts src/stages/compression/token-hashing.ts src/core/validation/language-support.ts src/core/validation/index.ts test/unit/elision-regions-mode.test.ts test/unit/language-support.test.ts
git commit -m "feat(elision): C and C# regions, deep mode only (R4)" -m "regionElisionLanguage returns c/csharp only with mode deep and a registered backend; they never reach the TypeScript scanner. Statement division honours the mode for the gate; the splitter stays Fast's. languageSupport is mode-aware and names the deep route. This is the step that moves output." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Measure §86 — C and C# reduce, each with its own fallback rate

- [ ] **Step 1: Build, and refreeze every corpus in place**

```bash
npm run build && npx tsc -p packages/deep/tsconfig.json
node tools/corpus-harness/manifest-in-place.js "$CORPORA/redis" --bucket redis --ext c,h --exclude deps --classify
node tools/corpus-harness/manifest-in-place.js "$CORPORA/curl" --bucket curl --ext c,h --classify
node tools/corpus-harness/manifest-in-place.js "$CORPORA/Newtonsoft.Json/Src" --bucket newtonsoft --ext cs --classify
node tools/corpus-harness/manifest-in-place.js "$CORPORA/jellyfin" --bucket jellyfin --ext cs --classify
```

- [ ] **Step 2: Measure deep mode at ratio 0.3, file route**

```bash
for c in redis curl Newtonsoft.Json/Src jellyfin; do node tools/corpus-harness/measure.js "$CORPORA/$c" --variant r4-deep --engine-mode deep --routes file; done
```

Expected: 0 failed runs, with a row count equal to the manifest's `totals.files`.

- [ ] **Step 3: Cross-check the ceiling against §82**

Run `ceiling.js` on each corpus. The C# grammar is now resolvable from `packages/deep`, so
`--grammar` can point at its `node_modules` path. Compare the source-class ceiling against §82's
table:

- **C:** redis 65.5%, curl 58.0%
- **C#:** Newtonsoft.Json 51.3%, jellyfin 53.7%

A difference of more than 0.5pp means the backend's tables drifted from the instrument's. Find
the node type and reconcile it, test first, before quoting any reduction.

- [ ] **Step 4: Analyse per corpus, never as an aggregate**

From each `results-r4-deep.jsonl`, report the following by bucket (`-source` and `-test`
separately):

- files, reduced, fallbacks, and saved %;
- fallback causes, from the row's `issueCodes` / `fallbackReason` field — whichever
  `measure.js`'s `flatten` emits; read its source to confirm the key;
- the 25–35% adherence band and the rows above 50%.

Read at least ten fallback rows per language and classify each:

- a `CONSTRAINT_DIRECTIVE_LOST` on a `#if`/`#define` line (spec §8 risk);
- a lexer flag;
- drift.

- [ ] **Step 5: Run the main corpus in both modes**

Run `measure.js` on `$CORPORA/main` with `--engine-mode deep`, A9 candidate against A11.
Expected:

- every non-`c` row `outputSha`-identical;
- every `c`-bucket row that moves is read and classified.

Re-run the Fast arm. Expected: all 594 rows identical to A9.

- [ ] **Step 6: Record and commit**

`## 86. R4 Step 3: C And C# Reduce Under Deep, At Their Own Fallback Rates`. Include the
per-corpus table, causes, adherence, the ceiling cross-check, and the main-corpus result. The
"What this does not establish" list must include:

- stdin, because `measure.js` passes no `--language`;
- any ratio but 0.3;
- retention;
- C++ in `.h` files beyond what the corpora held.

Then:

- **`CHANGELOG.md`:** add **"C and C# reduce under deep mode (DECISIONS §86)"** with the table.
- **`CLAUDE.md`:** in "Where the project actually is", replace the R4 "NEXT, and not started"
  sentence with one line: R4 Part A landed, see §84–§86.
- **`README.md`:** add C and C# to the languages table, marked "deep mode". Add them to the
  validator table, "balance only" like TypeScript.

```bash
git add DECISIONS.md CHANGELOG.md CLAUDE.md README.md
git commit -m "docs: R4 step 3 measured — C and C# reduce under deep (§86)" -m "<per-corpus figures>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Open PR A

- [ ] **Step 1: Full verification**

```bash
npm run typecheck && npm run lint && npm run build && npx tsc -p packages/deep/tsconfig.json && npx vitest run
```

Expected: every step clean. Record the test count.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin r4/languages
gh pr create --repo ojassug/TokenDamper --base main --head r4/languages --title "R4: C and C# reduce under deep mode (§84–§86)" --body-file <body>
```

The body is the three steps' headline figures, the fast-mode identity result, and the test
count, ending with the attribution line. Call `mcp__ccd_pr__get_status` after opening. **Do not
merge**: PR B stacks on it, and both are merged on one approval.

---

## Part B — the 2.0 surface (PR B, stacked on A)

### Task 13: `--mode fast|deep`, and the two withdrawals

**Files:**
- Modify: `src/cli/main.ts`. In `COMMON_FLAGS` (≈611) remove `'--mode'`. In
  `SUPPORTED_FLAGS.optimize` swap `'--engine-mode'` for `'--mode'`. Rewrite the `--mode` branch
  (≈749–760), remove the `--engine-mode` branch (≈867–873), and update the `--engine-mode`
  comment block (≈634–641).
- Rename: `test/unit/cli/engine-mode-flag.test.ts` → `test/unit/cli/mode-flag.test.ts`.
- Modify: `test/unit/cli/withdrawn-knobs.test.ts` (append) and `test/unit/cli/flag-support.test.ts`
  (update the expectations).
- Modify: `src/core/validation/language-support.ts` (`--engine-mode deep` → `--mode deep`) and
  its test regex.

**Interfaces:**
- Produces: `parseArguments` sets `engineMode` from `--mode fast|deep` on `optimize`.
  `--mode optimize|bench` and `--engine-mode` throw errors naming their replacements.

- [ ] **Step 1: Write the failing tests**

`test/unit/cli/mode-flag.test.ts`, replacing `engine-mode-flag.test.ts`, which is deleted:

```ts
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../../../src/cli/main';

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let err = '';
  stdout.resume();
  stderr.on('data', (c) => (err += String(c)));
  return { stdout, stderr, get err() { return err; } };
}

describe('--mode is the engine at 2.0 (DECISIONS §87)', () => {
  it('accepts fast, which is the default', () => {
    expect(runCli(['optimize', 'README.md', '--mode', 'fast'], io())).toBe(0);
  });

  it('rejects a value that is neither fast nor deep', () => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--mode', 'turbo'], s)).toBe(1);
    expect(s.err).toContain('Accepted values: fast, deep');
  });

  it.each(['optimize', 'bench'])('names the positional command for the withdrawn --mode %s', (value) => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--mode', value], s)).toBe(1);
    expect(s.err).toContain(`--mode ${value} was withdrawn in 2.0.0`);
    expect(s.err).toContain(`tokendamper ${value}`);
  });

  it('names --mode for the withdrawn --engine-mode', () => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--engine-mode', 'deep'], s)).toBe(1);
    expect(s.err).toContain('--engine-mode was withdrawn in 2.0.0; use --mode fast|deep');
  });

  it.each(['bench', 'mcp'])('is refused on %s, naming where it applies', (command) => {
    const s = io();
    expect(runCli([command, '--mode', 'deep'], s)).toBe(1);
    expect(s.err).toContain('applies to: optimize');
  });
});
```

Append to `test/unit/cli/withdrawn-knobs.test.ts`:

```ts
describe('--engine-mode and the old --mode values (2.0.0)', () => {
  it('are absent from every command in the flag table', () => {
    for (const command of ['optimize', 'bench', 'mcp'] as const) {
      expect(SUPPORTED_FLAGS[command].has('--engine-mode')).toBe(false);
    }
    expect(SUPPORTED_FLAGS.optimize.has('--mode')).toBe(true);
    expect(SUPPORTED_FLAGS.bench.has('--mode')).toBe(false);
    expect(SUPPORTED_FLAGS.mcp.has('--mode')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/cli/mode-flag.test.ts test/unit/cli/withdrawn-knobs.test.ts`
Expected: FAIL. `--mode fast` is invalid today, and `--engine-mode` is accepted.

- [ ] **Step 3: Implement** in `src/cli/main.ts`

```ts
const COMMON_FLAGS = [
  '--config',
  '--planner-mode',
  '--minimum-confidence',
  '--log-level',
  '--max-input-tokens',
  '--target-reduction-ratio',
  '--preserve-kinds',
] as const;
```

`SUPPORTED_FLAGS.optimize` lists `'--mode'` where `'--engine-mode'` was. Replace the comment
above `bench` with:

```ts
  // `--mode` (the engine) is optimize-only. `src/bench/runner.ts` never reads an engine mode, and
  // the MCP server registers no backends, so accepting `--mode deep` on either would report a
  // deep run that never happened (invariant 10). Deep through bench or MCP is closed as not done
  // in DECISIONS §88.
```

The `--mode` branch:

```ts
    if (flag === '--mode') {
      const value = args.shift();
      if (value === 'fast' || value === 'deep') {
        engineMode = value;
        continue;
      }
      if (value === 'optimize' || value === 'bench') {
        // 2.0.0 (DECISIONS §87): `optimize` was the identity and `bench` duplicated the positional
        // command, so the name was freed for the engine. A parse error naming the replacement,
        // never a silent reinterpretation.
        throw new Error(
          `--mode ${value} was withdrawn in 2.0.0; run \`tokendamper ${value} …\` instead. --mode now selects the engine: fast (default) or deep.`,
        );
      }
      throw new Error('Invalid value for --mode. Accepted values: fast, deep.');
    }

    if (flag === '--engine-mode') {
      throw new Error('--engine-mode was withdrawn in 2.0.0; use --mode fast|deep.');
    }
```

Delete the old `--engine-mode` branch at ≈867–873. Remove the
`configOverrides.appMode = value;` path entirely, so nothing sets `appMode` from the CLI any
more. In `language-support.ts`, change the note to
`' C and C# reduce only under --mode deep, which needs the tokendamper-deep package.'` and
update Task 10's test regex to `/C and C# reduce only under --mode deep/`.

- [ ] **Step 4: Run them, then the full suite**

Run: `npx vitest run`
Expected: PASS. `flag-support.test.ts` may pin the old `COMMON_FLAGS`; update it.

- [ ] **Step 5: Commit**

```bash
git rm test/unit/cli/engine-mode-flag.test.ts
git add src/cli/main.ts src/core/validation/language-support.ts test/unit
git commit -m "feat(cli)!: --mode selects the engine; --mode optimize|bench and --engine-mode withdrawn (2.0)" -m "BREAKING CHANGE: --mode accepts fast|deep on optimize only. --mode optimize|bench and --engine-mode are parse errors naming their replacements." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Config `engine.mode`, `TOKENDAMPER_ENGINE_MODE`, and the withdrawn `app.mode`

**Files:**
- Modify: `src/config/types.ts`. `ConfigFileShape` gains `engine?: { mode?: EngineMode }`, and
  `app.mode` becomes `unknown`. `ConfigOverrides` drops `appMode` and gains `engineMode`.
  `TokenDamperConfig` gains `engineMode` and `notices`.
- Modify: `src/config/schema.ts`. `DEFAULT_CONFIG` gains `engineMode: 'fast'` and `notices: []`;
  `isConfigFileShape` validates `engine.mode` and stops validating `app.mode`.
- Modify: `src/config/load.ts`. Apply the file, env and CLI layers for `engineMode`, and emit
  notices for `app.mode` and `TOKENDAMPER_APP_MODE`.
- Modify: `src/cli/main.ts`. In `runCli`, resolve config once for optimize, bench and mcp; write
  the notices; take the engine mode from config; refuse a resolved `deep` on bench and mcp.
- Test: `test/unit/config-engine-mode.test.ts`

**Interfaces:**
- Produces: `TokenDamperConfig.engineMode: EngineMode` and
  `TokenDamperConfig.notices: ReadonlyArray<string>`.
- Precedence: CLI, then env, then file, then default.

- [ ] **Step 1: Write the failing test** `test/unit/config-engine-mode.test.ts`

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { runCli } from '../../src/cli/main';

const dirWith = (config?: object) => {
  const d = mkdtempSync(join(tmpdir(), 'tokendamper-engine-'));
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n', 'utf8');
  if (config) writeFileSync(join(d, 'tokendamper.config.json'), JSON.stringify(config), 'utf8');
  return d;
};

describe('engine.mode (DECISIONS §87)', () => {
  it('defaults to fast', () => {
    expect(loadConfig({ cwd: dirWith(), env: {} }).engineMode).toBe('fast');
  });

  it('reads the file, then the environment, then the CLI', () => {
    const cwd = dirWith({ engine: { mode: 'deep' } });
    expect(loadConfig({ cwd, env: {} }).engineMode).toBe('deep');
    expect(loadConfig({ cwd, env: { TOKENDAMPER_ENGINE_MODE: 'fast' } }).engineMode).toBe('fast');
    expect(loadConfig({ cwd, env: {}, cliOverrides: { engineMode: 'fast' } }).engineMode).toBe('fast');
  });

  it('rejects an unrecognised value from any door', () => {
    expect(() => loadConfig({ cwd: dirWith(), env: { TOKENDAMPER_ENGINE_MODE: 'turbo' } })).toThrow(/Accepted values: fast, deep/);
    expect(() => loadConfig({ cwd: dirWith({ engine: { mode: 'turbo' } }), env: {} })).toThrow(/Invalid TokenDamper config file/);
  });
});

describe('app.mode is a withdrawn key (2.0.0)', () => {
  it('still loads, with a notice naming the replacement', () => {
    const config = loadConfig({ cwd: dirWith({ app: { mode: 'bench' } }), env: {} });
    expect(config.notices.join('\n')).toMatch(/app\.mode was withdrawn in 2\.0\.0/);
  });

  it('accepts any value it used to reject, because nothing reads it', () => {
    expect(() => loadConfig({ cwd: dirWith({ app: { mode: 'explain' } }), env: {} })).not.toThrow();
  });

  it('treats TOKENDAMPER_APP_MODE the same way', () => {
    const config = loadConfig({ cwd: dirWith(), env: { TOKENDAMPER_APP_MODE: 'optimize' } });
    expect(config.notices.join('\n')).toMatch(/TOKENDAMPER_APP_MODE was withdrawn in 2\.0\.0/);
  });

  it('writes the notice to stderr once per run', () => {
    const cwd = dirWith({ app: { mode: 'optimize' } });
    let err = '';
    const stderr = new PassThrough();
    stderr.on('data', (c) => (err += String(c)));
    const stdout = new PassThrough();
    stdout.resume();
    expect(runCli(['optimize', join(cwd, 'a.ts')], { stdout, stderr }, cwd)).toBe(0);
    expect(err.match(/app\.mode was withdrawn/g)).toHaveLength(1);
  });
});

describe('a resolved deep engine on bench or mcp is refused (invariant 10)', () => {
  it.each(['bench', 'mcp'])('%s', (command) => {
    const cwd = dirWith({ engine: { mode: 'deep' } });
    let err = '';
    const stderr = new PassThrough();
    stderr.on('data', (c) => (err += String(c)));
    const stdout = new PassThrough();
    stdout.resume();
    expect(runCli([command], { stdout, stderr }, cwd)).toBe(1);
    expect(err).toContain(`${command} runs the fast engine only`);
    expect(err).toContain('TOKENDAMPER_ENGINE_MODE=fast');
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run test/unit/config-engine-mode.test.ts`
Expected: FAIL. `engineMode` and `notices` are undefined.

- [ ] **Step 3: Implement**

`src/config/types.ts`:

```ts
import type { EngineMode } from '../core/parser/mode';
```

```ts
export interface ConfigFileShape {
  readonly configSchemaVersion?: string;
  readonly app?: {
    readonly name?: string;
    readonly version?: string;
    /** Withdrawn in 2.0.0 (DECISIONS §87). Loaded, never read, and reported as a notice. */
    readonly mode?: unknown;
  };
  /** The engine backend (2.0.0): `fast` (default) or `deep`. */
  readonly engine?: {
    readonly mode?: EngineMode;
  };
  // …planner, budget, validation, logging unchanged
}

export interface ConfigOverrides {
  engineMode?: EngineMode;
  plannerMode?: OptimizationMode;
  minimumConfidence?: number;
  logLevel?: LogLevel;
  budget?: Partial<OptimizationBudget>;
}

export type TokenDamperConfig = ResolvedConfig & {
  readonly configSchemaVersion?: string;
  /** Which backend discovers regions. Read by `optimize` only. */
  readonly engineMode: EngineMode;
  /** Startup notices — withdrawn keys still present. Written once to stderr by the CLI. */
  readonly notices: ReadonlyArray<string>;
};
```

Drop the now-unused `AppMode` import if lint flags it. `ResolvedConfig.appMode` stays on the core
model; nothing sets it except `DEFAULT_CONFIG`.

`src/config/schema.ts`: add `engineMode: 'fast'` and `notices: []` to `DEFAULT_CONFIG`. In
`isConfigFileShape`, replace the `app` clause:

```ts
    (file.app === undefined ||
      (isPlainObject(file.app) &&
        (file.app.name === undefined || typeof file.app.name === 'string') &&
        (file.app.version === undefined || typeof file.app.version === 'string'))) &&
    (file.engine === undefined ||
      (isPlainObject(file.engine) && (file.engine.mode === undefined || file.engine.mode === 'fast' || file.engine.mode === 'deep'))) &&
```

Delete `isAppMode`.

`src/config/load.ts`:

```ts
const APP_MODE_NOTICE =
  'app.mode was withdrawn in 2.0.0 and is ignored. For the engine use engine.mode (fast|deep); for the benchmark run `tokendamper bench`.';
const APP_MODE_ENV_NOTICE =
  'TOKENDAMPER_APP_MODE was withdrawn in 2.0.0 and is ignored. For the engine use TOKENDAMPER_ENGINE_MODE (fast|deep).';
```

In `applyFileConfig`, remove `appMode: …` and add:

```ts
    engineMode: fileConfig.engine?.mode ?? base.engineMode,
    notices: fileConfig.app?.mode !== undefined ? [...base.notices, APP_MODE_NOTICE] : base.notices,
```

In `applyEnvOverrides`, remove `appMode: parseAppMode(…)` and add:

```ts
    engineMode: parseEnvEnum('TOKENDAMPER_ENGINE_MODE', env.TOKENDAMPER_ENGINE_MODE, ['fast', 'deep'] as const) ?? base.engineMode,
    notices: env.TOKENDAMPER_APP_MODE !== undefined ? [...base.notices, APP_MODE_ENV_NOTICE] : base.notices,
```

In `applyCliOverrides`, remove `appMode: …` and add:

```ts
    engineMode: cliOverrides.engineMode ?? base.engineMode,
```

Delete `parseAppMode`.

`src/cli/main.ts`:
- `parseArguments` carries the flag's value into the config overrides, so the file, environment
  and CLI layers resolve it with their one precedence rule. It no longer returns `engineMode` on
  its own.
- Delete `...(engineMode === 'deep' ? { engineMode } : {}),` from the `optimize` return, and add
  the flag's value where `resolvedOverrides` is built:

```ts
  const resolvedOverrides: Partial<ConfigOverrides> = {
    ...configOverrides,
    ...(engineModeFromFlag ? { engineMode: engineModeFromFlag } : {}),
    // …existing fields (minimumConfidence, budget) unchanged
  };
```

Rename the local `engineMode` to `engineModeFromFlag: 'fast' | 'deep' | undefined`, initialised
to `undefined`.

`runCli` becomes:

```ts
export function runCli(argv, io = { stdout: process.stdout, stderr: process.stderr }, cwd = process.cwd()) {
  try {
    const parsed = parseArguments(argv, cwd);
    let engineMode: EngineMode = 'fast';

    if (parsed.command === 'optimize' || parsed.command === 'bench' || parsed.command === 'mcp') {
      const config = loadConfig({
        cwd,
        ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
        ...(parsed.configOverrides ? { cliOverrides: parsed.configOverrides } : {}),
      });
      for (const notice of config.notices) io.stderr.write(`tokendamper: ${notice}\n`);
      engineMode = config.engineMode;
      if (engineMode === 'deep' && parsed.command !== 'optimize') {
        throw new Error(
          `tokendamper: the engine resolves to deep (engine.mode or TOKENDAMPER_ENGINE_MODE), but ${parsed.command} runs the fast engine only. Set TOKENDAMPER_ENGINE_MODE=fast for this command, or remove engine.mode.`,
        );
      }
    }

    const withMode = engineMode === 'deep' ? { ...parsed, engineMode } : parsed;
    if (engineMode === 'deep') {
      return registerDeepBackends()
        .then(() => dispatch(withMode, io, cwd))
        .catch((err: unknown) => {
          io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
          return 1;
        });
    }
    return dispatch(withMode, io, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown TokenDamper error';
    io.stderr.write(`${message}\n`);
    return 1;
  }
}
```

`dispatch` keeps reading `parsed.engineMode` at its two call sites (≈288 and ≈381); they now
receive the resolved mode. Check `parsed.configOverrides` naming: it is `configOverrides` on
`ParsedArgs`, so use the existing property name.

- [ ] **Step 4: Run it, then the full suite, typecheck and lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS. Two existing config tests may need updating:

- one asserting `TOKENDAMPER_APP_MODE=explain` throws now finds it accepted with a notice;
- the withdrawn-knobs `appMode` cases.

Update each to the new truth and name them in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/config src/cli/main.ts test/unit
git commit -m "feat(config)!: engine.mode and TOKENDAMPER_ENGINE_MODE; app.mode withdrawn with a notice (2.0)" -m "BREAKING CHANGE: app.mode / TOKENDAMPER_APP_MODE are ignored with a startup notice. A resolved deep engine on bench or mcp is refused, naming the per-command override." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: The harness speaks `--mode`

**Files:**
- Modify: `tools/corpus-harness/measure.js:10,79,215,231-234`. The option becomes `--mode` and
  the CLI flag passed becomes `--mode`.
- Modify: `tools/corpus-harness/README.md` (examples).

- [ ] **Step 1: Edit**

```js
    if (engineMode) args.push('--mode', engineMode);
```

```js
  const engineMode = opt('mode', undefined);
  if (engineMode !== undefined && engineMode !== 'fast' && engineMode !== 'deep') {
    console.error(`--mode must be fast or deep, got ${JSON.stringify(engineMode)}`);
    process.exit(2);
  }
```

Update the usage strings at lines 10 and 215 to `[--mode fast|deep]`.

- [ ] **Step 2: Smoke-test against the frozen main corpus**

```bash
npm run build && node tools/corpus-harness/measure.js "$CORPORA/main" --variant b15-fast --routes file
```

Expected: 297 rows, 0 failed, and every `outputSha` identical to the A11 fast run.

- [ ] **Step 3: Commit**

```bash
git add tools/corpus-harness/measure.js tools/corpus-harness/README.md
git commit -m "chore(harness): measure.js passes --mode (2.0)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: `tokendamper-deep` becomes publishable

**Files:**
- Modify: `packages/deep/package.json`
- Create: `packages/deep/README.md`, and `packages/deep/LICENSE` (copy the root `LICENSE`
  byte-for-byte).
- Modify: `src/cli/deep-backends.ts` (error texts).
- Modify: `test/unit/published-package-scope.test.ts` (append).
- Test: `test/unit/cli/deep-backends-message.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/published-package-scope.test.ts`:

```ts
describe('tokendamper-deep is a separate, publishable package (2.0.0)', () => {
  const repoRoot = join(__dirname, '..', '..');
  const read = (p: string) => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')) as Record<string, any>;
  const core = read('package.json');
  const deep = read('packages/deep/package.json');

  it('is public, and versioned in lockstep with core', () => {
    expect(deep.private).toBeUndefined();
    expect(deep.version).toBe(core.version);
  });

  it('ships its build, README and LICENSE only', () => {
    expect(deep.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(existsSync(join(repoRoot, 'packages/deep/README.md'))).toBe(true);
    expect(readFileSync(join(repoRoot, 'packages/deep/LICENSE'))).toEqual(readFileSync(join(repoRoot, 'LICENSE')));
  });

  it('declares core as an optional peer, so a workspace install never fetches an unpublished core', () => {
    expect(deep.peerDependencies?.tokendamper).toBe(`^${String(core.version).split('.')[0]}.0.0`);
    expect(deep.peerDependenciesMeta?.tokendamper?.optional).toBe(true);
  });

  it('keeps core free of runtime dependencies and of packages/', () => {
    expect(core.dependencies).toBeUndefined();
    expect((core.files as string[]).some((f) => f.startsWith('packages'))).toBe(false);
  });
});
```

Add `existsSync` to that file's `node:fs` import. Create
`test/unit/cli/deep-backends-message.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the deep discovery error names the install (2.0.0)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'cli', 'deep-backends.ts'), 'utf8');
  it('tells a user to install the package, not that it is unpublished', () => {
    expect(src).toContain('npm install tokendamper-deep');
    expect(src).not.toContain('unpublished in R3');
    expect(src).toContain('--mode deep');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run test/unit/published-package-scope.test.ts test/unit/cli/deep-backends-message.test.ts`
Expected: FAIL. The package is `private`, at `0.0.0`, with no `files`.

- [ ] **Step 3: Implement**

`packages/deep/package.json`: keep the `dependencies` block exactly as Task 7's install left it;
the six grammar and runtime versions are not repeated here.

```json
{
  "name": "tokendamper-deep",
  "version": "1.8.0",
  "description": "Deep mode for TokenDamper: tree-sitter (WASM) parser backends. C and C# reduce only through it; it also answers for TypeScript, Python and Go.",
  "license": "MPL-2.0",
  "repository": { "type": "git", "url": "https://github.com/ojassug/TokenDamper.git", "directory": "packages/deep" },
  "homepage": "https://github.com/ojassug/TokenDamper/tree/main/packages/deep",
  "keywords": ["tokendamper", "tree-sitter", "context-optimization", "token-reduction"],
  "engines": { "node": "^20.19.0 || ^22.13.0 || >=24" },
  "type": "commonjs",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist", "README.md", "LICENSE"],
  "scripts": {
    "clean": "node -e \"require('fs').rmSync('dist', { recursive: true, force: true })\"",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "prepublishOnly": "npm run clean && npm run build"
  },
  "peerDependencies": { "tokendamper": "^1.0.0" },
  "peerDependenciesMeta": { "tokendamper": { "optional": true } },
  "dependencies": {
    "…": "unchanged from Task 7"
  }
}
```

The version is `1.8.0`, in lockstep with core *now*. Task 19 bumps both to `2.0.0` and the peer
range to `^2.0.0`. The lockstep test passes at every commit because both move together.

`packages/deep/README.md`:

````markdown
# tokendamper-deep

Deep mode for [TokenDamper](https://github.com/ojassug/TokenDamper): tree-sitter parser backends,
compiled to WebAssembly, that the `tokendamper` CLI loads when you pass `--mode deep`.

## What it adds

| language | Fast (default) | Deep |
|---|---|---|
| TypeScript / JavaScript, Python, Go | reduces | reduces; function bodies come from the parser |
| **C, C#** | validated, never reduced | **reduces** |

Deep finds function bodies with a real parser. Validation is unchanged: every language keeps the
Fast path's bracket/quote check, because the elision marker is not valid syntax in any grammar
(DECISIONS §81).

## Install

Install it next to `tokendamper`, in the same place — both global, or both in one project:

```bash
npm install -g tokendamper tokendamper-deep
```

```bash
tokendamper optimize src/server.c --mode deep --target-reduction-ratio 0.3
```

Without this package, `--mode deep` exits with an error naming this install command. It never
quietly runs Fast instead.

## Licence

MPL-2.0, as TokenDamper.
````

`src/cli/deep-backends.ts`:
- Rewrite the doc paragraph that calls the bare specifier "the R4 shape" and says "the package is
  `private: true`" so that it describes the 2.0 state. The bare specifier is the published
  package. The repo-relative path is for checkouts.
- The two error messages become:

```ts
      'tokendamper: --mode deep registered no parser backends. Refusing to run, because ' +
        'falling back to the fast path here would report a deep run that never happened.',
```

```ts
  throw new Error(
    'tokendamper: --mode deep needs the tokendamper-deep package. Install it next to tokendamper ' +
      '(npm install tokendamper-deep — global if tokendamper is global). From a repository ' +
      'checkout, build it instead:\n  npx tsc -p packages/deep/tsconfig.json\nTried:\n  ' +
      failures.join('\n  '),
  );
```

```bash
cp LICENSE packages/deep/LICENSE
```

- [ ] **Step 4: Run them, then inspect both tarballs**

```bash
npx vitest run && npm run build && npx tsc -p packages/deep/tsconfig.json
npm pack --dry-run 2>&1 | tail -20
npm pack --dry-run -w tokendamper-deep 2>&1 | tail -30
```

Expected:
- **Core:** no `packages/` entry, and the entry count matches v1.8.0's 238 files give or take
  the new `dist` files from Tasks 2, 3 and 8.
- **Deep:** `dist/*.js` and `dist/*.d.ts`, `README.md`, `LICENSE` and `package.json` only.

Record both counts and sizes for Task 17.

- [ ] **Step 5: Commit**

```bash
git add packages/deep/package.json packages/deep/README.md packages/deep/LICENSE package-lock.json src/cli/deep-backends.ts test/unit/published-package-scope.test.ts test/unit/cli/deep-backends-message.test.ts
git commit -m "feat(deep): tokendamper-deep is publishable (2.0)" -m "Public, lockstep-versioned, files dist/README/LICENSE, tokendamper as an optional peer so workspace installs never fetch an unpublished core. The discovery error names npm install tokendamper-deep." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: PR B's docs, and opening it

**Files:**
- Modify: `README.md`. Replace the CLI flags table row for `--mode`, add a "Deep mode" section
  linking `packages/deep/README.md`, and add a "Breaking in 2.0" note.
- Modify: `ARCHITECTURE.md`. Find the section that states per-configuration determinism (line
  ≈545) and add one sentence: C and C# reach elision only through a Deep backend; the Fast path
  validates and measures them but has no region scanner for either (DECISIONS §84–§86).
- Modify: `CHANGELOG.md`. Under `## [Unreleased]`, add a `### Breaking` section **first** listing
  Tasks 13–14, and an `### Added` entry for the publishable package.
- Modify: `DECISIONS.md`. Add §87, "The 2.0 Surface: `--mode` Is The Engine, And The Package Is
  Public". Record:
  - why `--engine-mode` is withdrawn rather than aliased;
  - why the peer dependency is optional;
  - the refusal on bench and mcp, and its per-command override;
  - the tarball counts from Task 16.

- [ ] **Step 1: Write the docs above, then verify**

```bash
npm run typecheck && npm run lint && npm run build && npx tsc -p packages/deep/tsconfig.json && npx vitest run
```

- [ ] **Step 2: Commit, push, open PR B**

```bash
git add README.md ARCHITECTURE.md CHANGELOG.md DECISIONS.md
git commit -m "docs: the 2.0 surface (§87)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin r4/surface
gh pr create --repo ojassug/TokenDamper --base r4/languages --head r4/surface --title "2.0 surface: --mode fast|deep, engine.mode, tokendamper-deep publishable (§87)" --body-file <body>
```

Then ask the owner, in one question, to approve merging **PR A then PR B** by number. After A
merges, retarget B with `gh pr edit <B> --base main` before merging it.

---

## Part C — the close and the release (PR C)

### Task 18: The closing record

**Files:**
- Modify: `DECISIONS.md`, adding §88, "TokenDamper Is Complete: Every Held Item, Closed As Not
  Done". It has one row per item from spec §9, each with the reason it was held, the reason it is
  not done, and the precondition that would have unblocked it.
- Modify: `ROADMAP.md`. Rewrite the header and the R4/v2.0.0 sections as shipped. The "held" and
  "unnumbered" entries become "closed, not done — §88". Nothing is deleted.
- Modify: `CLAUDE.md`. "Where the project actually is" becomes the completed state: v2.0.0 is the
  final release, and the record lives in DECISIONS §84–§88 and the status doc. Remove the "Start
  at `docs/r4-start-here.md`" sentence.
- Modify: `docs/audit-remediation-status.md`. The header records v2.0.0 as the final release.
- Delete: `docs/r4-start-here.md`. In the same commit, `tools/corpus-harness/recipe.json`
  `prose.expect` decrements by one, with a `$comment` entry naming the file. The plan doc
  (`+1`, added with this plan) and the spec (`+1`) are already counted.
- Modify: `.claude/skills/release/SKILL.md`, adding a "Two packages" section:
  - publish core, then deep, from the main checkout after `git pull`;
  - read both banners;
  - verify both with `npm view <name> version --prefer-online` and `gitHead`.

- [ ] **Step 1: Write them, then confirm the corpus count**

```bash
node tools/corpus-harness/collect.js "$CORPORA/countcheck-c18"
```

Expected: every bucket `ok`, with prose at the new `expect`.

- [ ] **Step 2: Commit**

```bash
git add -A DECISIONS.md ROADMAP.md CLAUDE.md docs tools/corpus-harness/recipe.json .claude/skills/release/SKILL.md
git commit -m "docs: TokenDamper is complete — every held item closed as not done (§88)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 19: Cut v2.0.0

Follow the `release` skill exactly. Its sequence is the authority; the steps below are this
release's specifics.

- [ ] **Step 1: Branch from merged `main`, and say the number**

```bash
git fetch origin && git checkout -b release/v2.0.0 origin/main
```

The number is **2.0.0, a major**: `--mode optimize|bench`, `--engine-mode` and `app.mode` are
withdrawn (spec §4.6). Confirm it with the owner, together with the PR C merge approval.

- [ ] **Step 2: Bump both packages**

`src/version.ts` → `export const TOKENDAMPER_VERSION = '2.0.0';`

```bash
npm version 2.0.0 --no-git-tag-version
npm version 2.0.0 --no-git-tag-version -w tokendamper-deep
```

In `packages/deep/package.json`, set `"peerDependencies": { "tokendamper": "^2.0.0" }`.

- [ ] **Step 3: CHANGELOG**

Promote `[Unreleased]` to `## [v2.0.0] - 2026-10-DD`. The lede leads with what breaks
(`--mode`, `--engine-mode`, `app.mode`), then what is new (C and C# under deep, the package),
then §83's Python change with its fallback cost, then "the final release". Keep every measured
table.

- [ ] **Step 4: Verify, and read the output**

```bash
npm run typecheck && npm run lint && npm test && npm run build && npx tsc -p packages/deep/tsconfig.json
node -e "console.log(require('./dist/src/version.js').TOKENDAMPER_VERSION)"
node -e "console.log(require('./package.json').version, require('./packages/deep/package.json').version)"
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"1"}}}' | node dist/src/cli/main.js mcp 2>/dev/null | head -1
npm pack --dry-run 2>&1 | tail -5 && npm pack --dry-run -w tokendamper-deep 2>&1 | tail -5
```

Expected: every reporter says `2.0.0`, and both tarballs match Task 16's inventory.

- [ ] **Step 5: PR, merge on approval, tag, release**

```bash
gh pr create --repo ojassug/TokenDamper --base main --head release/v2.0.0 --title "release v2.0.0 — the final release" --body-file <notes>
# after the owner approves this PR number:
gh pr merge <n> --repo ojassug/TokenDamper --merge --subject "Merge pull request #<n>: release v2.0.0 — the final release"
git fetch origin && git tag -a v2.0.0 origin/main -m "v2.0.0 — the language list stops being hand-written" && git push origin v2.0.0
gh release create v2.0.0 --repo ojassug/TokenDamper --title "v2.0.0 — the language list stops being hand-written" --notes-file <notes>
```

- [ ] **Step 6: Hand the publishes to the owner**

Say which directory, and tell them to read the banner. These go in the owner's main checkout at
`C:\Users\ojass\Projects\TokenDamper`:

```bash
git pull origin main
```

```bash
npm ci
```

```bash
npm publish
```

```bash
npm publish -w tokendamper-deep
```

Before each 2FA prompt, the banner must read `tokendamper@2.0.0` for the first publish and
`tokendamper-deep@2.0.0` for the second. `npm ci` comes first because the main checkout's
`node_modules` predates the new grammars (memory: `npm-publish-needs-user-2fa`).

- [ ] **Step 7: After they publish, verify the artifacts, not just the numbers**

```bash
npm view tokendamper version --prefer-online && npm view tokendamper-deep version --prefer-online
npm view tokendamper@2.0.0 gitHead && npm view tokendamper-deep@2.0.0 gitHead   # both = the v2.0.0 tag commit
```

Hash the published `dist/src` (core) and `dist` (deep) against a local build of the tag; both
must be byte-identical. Then record the registry state in `CLAUDE.md`, `ROADMAP.md` and the
status doc in a final docs PR, the same way #77 recorded v1.8.0.

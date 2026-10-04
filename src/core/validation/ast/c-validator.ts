import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/** One `#if` group. Brackets count only while every enclosing group's open branch counts. */
interface ConditionalGroup {
  readonly line: number;
  /** The group's position in opening order, which is how the second pass finds its shape. */
  readonly index: number;
  /** The branch now open: 0 for the `#if`, then one more per `#elif`/`#else`. */
  branch: number;
  /** The condition's value in any C build, or null — see `GroupShape.truth`. */
  readonly truth: boolean | null;
  /** Whether no C build compiles the branch now open, which is what makes a `#define` here dead. */
  dead: boolean;
  /** Whether brackets count in the branch now open. */
  counting: boolean;
  /** Whether some branch of this group has already counted. */
  counted: boolean;
}

/**
 * Which build configuration a pass counts. A real build compiles exactly one branch per group:
 *
 *  - `first` takes the first live branch of every group;
 *  - `last` takes the `#else` of every group that has one, and is otherwise identical.
 *
 * Both count a group with no `#else` — a feature block — so damage inside one is caught by both.
 * Excluding those was the first draft of `last`, and it made every `#ifdef FEATURE` block a blind
 * spot: 22% of the mutation sites in redis and curl sat inside one (DECISIONS §84).
 */
type BranchSelection = 'first' | 'last';

/** What the first pass learns about a group, which the second pass needs to choose its branch. */
interface GroupShape {
  branches: number;
  hasElse: boolean;
  /**
   * An include guard — `#ifndef X` (or `#if !defined(X)`) whose next directive is `#define X`.
   * Its body is compiled on first inclusion in every build, so it is never a configuration choice.
   * Treating it as one made the "last branch" selection read every guarded header as empty.
   */
  guard: boolean;
  /**
   * The condition's value wherever it is visible without evaluating macros: `#if 0` is false,
   * and so is every test of `__cplusplus`, because this is a C validator and a C compiler never
   * defines it. That is what makes the ubiquitous `#ifdef __cplusplus` / `extern "C" {` /
   * `#endif` balance in both selections, closer present or not — 1,651 of the MSYS2 headers'
   * guarded braces sit inside one (§84).
   */
  truth: boolean | null;
}

/** The macro an `#ifndef X` or `#if !defined(X)` tests, or null for any other condition. */
const NEGATED_MACRO = /^!\s*defined\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)?$/;

/** Splits `expr` on `op` wherever it is not inside parentheses. */
function splitTopLevel(expr: string, op: '||' | '&&'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < expr.length; k++) {
    const ch = expr[k];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, k)) {
      parts.push(expr.slice(start, k));
      start = k + op.length;
      k += op.length - 1;
    }
  }
  parts.push(expr.slice(start));
  return parts;
}

/** Removes parentheses that enclose the whole of `expr`. */
function stripOuterParens(expr: string): string {
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

/** `R"delim( … )delim"`. C has no raw strings; a C++ header named `.h` does, and `.h` is C here. */
const RAW_STRING_PREFIXES: ReadonlySet<string> = new Set(['R', 'LR', 'uR', 'UR', 'u8R']);

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * Bracket, quote, comment and conditional balance for C — R4, step 1 (spec §4.2, DECISIONS §84).
 *
 * **Why C does not reuse `TypeScriptValidator`.** The grammars share `//`, `/* *\/` and three
 * bracket pairs, and that resemblance is what makes reuse look free — `GoValidator`'s header
 * records what it cost there. For C the divergences are the preprocessor and the literal forms:
 *
 *  - **Directives are not code.** `#define BEGIN {` is macro text, so brackets on a directive
 *    line — spliced continuation lines included — never count, and a lone quote there is ordinary
 *    text (`#error don't …`).
 *  - **Conditional groups.** A build compiles one branch per group, so brackets count in one
 *    branch per group — see `validate` for which. A condition whose value is visible without
 *    evaluating macros decides it outright: `#if 0` (how C disables code, which may be unbalanced)
 *    and every test of `__cplusplus`, which a C compiler never defines — what makes the ubiquitous
 *    `#ifdef __cplusplus` / `extern "C" {` / `#endif` guard balance. An include guard's body always
 *    counts. Groups must themselves balance: a region boundary that splits one is exactly the
 *    defect elision can introduce.
 *  - **Line splicing.** Backslash-newline joins lines everywhere except inside a raw string,
 *    including inside literals and `//` comments.
 *  - **Literals.** Character literals, prefixed literals (`L`, `u8`), C23 digit separators
 *    (`1'000'000` is one pp-number), and C++ raw strings for headers.
 *
 * **What it checks is balance, not syntax** — the same claim every Fast validator makes and the
 * README's table states. The elision marker spliced into a body is balanced, so this is the
 * post-condition check for C under deep mode (DECISIONS §81 is why Deep cannot be).
 */
export class CValidator implements AstValidator {
  readonly language: TargetLanguage = 'c';

  /**
   * Accepts content that balances under **either** of two consistent build configurations: the
   * first live branch of every group, or the `#else` of every group that has one (see
   * `BranchSelection`). Known conditions and include guards decide their groups in both.
   *
   * The census (DECISIONS §84) is why it is two. Under the first alone, `newapis.h`, which opens
   * an `else {` only in an `#else` branch, reads as broken; the second reads it as written.
   *
   * What this gives up is known and small: a middle `#elif` branch is counted by neither, so
   * damage confined to one is invisible here. What it keeps is every unconditional line, every
   * feature block with no `#else`, and conditional balance itself, which both passes check — so
   * an elision that splits a group is still caught.
   *
   * What it does not accept, deliberately: correlated groups (libstdc++'s tr1 header opens a
   * namespace in an `#elif` and closes it under a later `#if` with the same condition) and broken
   * code in a block nothing defines (`sti.h`'s `#ifdef NOT_IMPLEMENTED`). Accepting those means
   * excluding blocks with no `#else`, which the first draft did, at the cost of every feature
   * block. The census counts them as the false positives they are.
   */
  validate(content: string, _options?: AstValidatorOptions): AstCheckResult {
    const startTime = performance.now();
    const first = new CScanner(content, 'first');
    first.run();
    let issues: AstIssue[] = first.issues;
    if (issues.length > 0) {
      const last = new CScanner(content, 'last', first.shapes);
      last.run();
      if (last.issues.length === 0) issues = [];
    }
    return {
      valid: issues.length === 0,
      issues: Object.freeze(issues),
      durationMs: performance.now() - startTime,
    };
  }
}

class CScanner {
  readonly issues: AstIssue[] = [];
  /** Filled by a `first` pass; read by a `last` pass. */
  readonly shapes: GroupShape[] = [];
  private readonly stack: BracketStackItem[] = [];
  private readonly groups: ConditionalGroup[] = [];
  /** How many groups have opened so far — the next group's index. */
  private opened = 0;
  /** Macros this file defines only inside dead code, so a later test of one is decided. */
  private readonly deadOnlyMacros = new Set<string>();
  /** Macros this file defines anywhere a build may compile, which overrides a dead definition. */
  private readonly liveMacros = new Set<string>();
  private i = 0;
  private line = 1;
  private column = 0;
  /** No token yet on this logical line, so a `#` here starts a directive. */
  private atLineStart = true;
  private inDirective = false;

  constructor(
    private readonly src: string,
    private readonly selection: BranchSelection,
    private readonly knownShapes?: ReadonlyArray<GroupShape>,
  ) {}

  /**
   * The branch a `last` pass counts in a group. An include guard or a known-true condition is not
   * a choice, so it is decided exactly as in the `first` pass. Otherwise a group with an `#else`
   * counts the `#else` — after a known-false first branch too, where the `first` pass counts the
   * next one — and a group without one counts the branch the `first` pass does, because the two
   * configurations should differ only where a real build can.
   */
  private lastCountedBranch(index: number, fallback: number): number {
    const shape = this.knownShapes?.[index];
    if (shape === undefined) return fallback;
    if (shape.guard || shape.truth === true) return 0;
    if (shape.hasElse) return shape.branches - 1;
    if (shape.truth === false) return shape.branches > 1 ? 1 : -1;
    return 0;
  }

  /** The rest of this directive line, comments removed and trimmed. */
  private restOfDirective(): string {
    const end = this.src.indexOf('\n', this.i);
    return this.src
      .slice(this.i, end === -1 ? this.src.length : end)
      .replace(/\/\*.*?\*\//g, ' ')
      .replace(/\/\/.*$/, '')
      .trim();
  }

  /** The value of this group's condition in any C build, or null when it depends on the build. */
  private conditionTruth(name: string): boolean | null {
    const rest = this.restOfDirective();
    if (name === 'ifdef') return this.evaluate(`defined(${rest})`);
    if (name === 'ifndef') return this.evaluate(`!defined(${rest})`);
    return this.evaluate(rest);
  }

  /**
   * The value of a preprocessor condition in **any** C build, or null when it depends on the
   * build. Only what needs no macro values is decided: `0` and `1`; `__cplusplus`, which a C
   * compiler never defines; a macro this file defines only inside code no C build compiles
   * (FreeType's `FT_NEED_EXTERN_C` is defined under `#ifdef __cplusplus` and tested later); and
   * `!`, `&&` and `||` over those — `d3d11.h` writes `!defined(D3D11_NO_HELPERS) && defined(__cplusplus)`.
   */
  private evaluate(expr: string): boolean | null {
    const e = stripOuterParens(expr);
    const disjuncts = splitTopLevel(e, '||');
    if (disjuncts.length > 1) {
      const values = disjuncts.map((d) => this.evaluate(d));
      if (values.includes(true)) return true;
      return values.every((v) => v === false) ? false : null;
    }
    const conjuncts = splitTopLevel(e, '&&');
    if (conjuncts.length > 1) {
      const values = conjuncts.map((c) => this.evaluate(c));
      if (values.includes(false)) return false;
      return values.every((v) => v === true) ? true : null;
    }
    if (e.startsWith('!')) {
      const value = this.evaluate(e.slice(1));
      return value === null ? null : !value;
    }
    if (e === '0') return false;
    if (e === '1') return true;
    const tested = /^defined\s*\(?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)?$/.exec(e)?.[1] ?? (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e) ? e : null);
    if (tested === null) return null;
    if (tested === '__cplusplus' || this.deadOnlyMacros.has(tested)) return false;
    return null;
  }

  /** Whether the line being lexed sits in a branch no C build compiles. */
  private inDeadCode(): boolean {
    return this.groups.some((group) => group.dead);
  }

  /** Whether the group this `#ifndef`/`#if` opens is an include guard (see `GroupShape.guard`). */
  private opensIncludeGuard(name: string): boolean {
    const end = this.src.indexOf('\n', this.i);
    const rest = this.restOfDirective();
    const macro = name === 'ifndef' ? /^[A-Za-z_][A-Za-z0-9_]*$/.exec(rest)?.[0] : NEGATED_MACRO.exec(rest)?.[1];
    if (!macro || end === -1) return false;
    // The next line that is neither blank nor a comment must be `#define <macro>`.
    for (const line of this.src.slice(end + 1).split('\n', 8)) {
      const text = line.trim();
      if (text === '' || text.startsWith('//') || (text.startsWith('/*') && text.endsWith('*/'))) continue;
      return new RegExp(`^#\\s*define\\s+${macro}(?![A-Za-z0-9_])`).test(text);
    }
    return false;
  }

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
        const index = this.opened++;
        if (this.selection === 'first') {
          const guard = name !== 'ifdef' && this.opensIncludeGuard(name);
          const truth = this.conditionTruth(name);
          this.shapes[index] = { branches: 1, hasElse: false, guard, truth };
          // A known-false first branch never counts, and its next branch does; a known-true one
          // counts and its later branches do not — `counted` carries that to `#elif`/`#else`.
          const live = truth !== false;
          this.groups.push({ line, index, branch: 0, truth, dead: truth === false, counting: live, counted: live });
        } else {
          const truth = this.knownShapes?.[index]?.truth ?? null;
          const counting = this.lastCountedBranch(index, 0) === 0;
          this.groups.push({ line, index, branch: 0, truth, dead: truth === false, counting, counted: counting });
        }
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
        group.branch += 1;
        // After a known-true first branch every later one is dead; after a known-false one the
        // next branch may be live, so it is not.
        group.dead = group.truth === true;
        if (this.selection === 'first') {
          const shape = this.shapes[group.index];
          if (shape) {
            shape.branches += 1;
            if (name === 'else') shape.hasElse = true;
          }
          // The first branch that may be live counts; after `#if 0` that is this one.
          group.counting = !group.counted;
          group.counted = true;
        } else {
          group.counting = group.branch === this.lastCountedBranch(group.index, group.branch);
        }
        return;
      }
      case 'endif':
        if (this.groups.pop() === undefined) {
          this.issue(line, column, '#endif without a matching #if', 'AST_UNBALANCED_CONDITIONAL');
        }
        return;
      case 'define':
      case 'undef': {
        const macro = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.restOfDirective())?.[0];
        if (!macro) return;
        if (name === 'undef') {
          this.liveMacros.delete(macro);
          this.deadOnlyMacros.delete(macro);
        } else if (this.inDeadCode()) {
          if (!this.liveMacros.has(macro)) this.deadOnlyMacros.add(macro);
        } else {
          this.liveMacros.add(macro);
          this.deadOnlyMacros.delete(macro);
        }
        return;
      }
      default:
        return;
    }
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

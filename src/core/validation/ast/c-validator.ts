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
 * bracket pairs, and that resemblance is what makes reuse look free — `GoValidator`'s header
 * records what it cost there. For C the divergences are the preprocessor and the literal forms:
 *
 *  - **Directives are not code.** `#define BEGIN {` is macro text, so brackets on a directive
 *    line — spliced continuation lines included — never count, and a lone quote there is ordinary
 *    text (`#error don't …`).
 *  - **Conditional groups.** Brackets count in the first branch of each `#if`/`#ifdef`/`#ifndef`
 *    group only, which is what makes the ubiquitous `#ifdef __cplusplus` / `extern "C" {` /
 *    `#endif` guard balance, and an opener duplicated across branches. `#if 0` is the one branch
 *    whose deadness is visible without evaluating anything — and it is how C disables code, which
 *    may be unbalanced — so it never counts and its `#else` does. Groups must themselves balance:
 *    a region boundary that splits one is exactly the defect elision can introduce.
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

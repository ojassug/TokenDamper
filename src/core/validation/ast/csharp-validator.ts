import type { AstCheckResult, AstIssue, AstValidator, AstValidatorOptions, TargetLanguage } from './types';

interface BracketStackItem {
  readonly char: string;
  readonly line: number;
  readonly column: number;
}

/** One `#if` group. Brackets count only while every enclosing group's open branch counts. */
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
 *    `""` — so `@"C:\dir\"` ends where a C-style lexer thinks it continues.
 *  - **Raw strings** (`"""…"""`, any run of three or more) span lines and contain quotes freely.
 *  - **Interpolation** (`$"…{expr}…"`, `$@`, `@$`, `$$"""…{{expr}}…"""`) puts *code* inside a
 *    string, with its own brackets and nested strings; `{{` and `}}` are literal braces, and in a
 *    raw string N `$` signs mean a hole opens with N braces. Brackets inside a hole balance on
 *    their own, so a hole cannot close a bracket the code around its string opened.
 *  - **Directives** occupy whole lines and are not lexed — `#region Don't touch` is ordinary
 *    text. The first-branch rule for `#if` is `CValidator`'s, with `#if false` as the visibly dead
 *    branch, and a skipped section is not lexed at all, which is the C# specification's own rule.
 *    `#region`/`#endregion` must balance.
 *
 * **Balance, not syntax** — the Fast path's claim, and the post-condition for C# under deep mode.
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
      // U+FEFF is a byte-order mark. 549 of 3,165 Newtonsoft.Json and jellyfin files open with one
      // and then `#region License`, and reading it as a token hid that directive (§84).
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '﻿') {
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
        // A run of at least `dollars` braces opens a hole; any braces before the last `dollars`
        // are content.
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

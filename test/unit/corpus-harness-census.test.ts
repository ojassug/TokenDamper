import { describe, expect, it } from 'vitest';
import * as path from 'path';

/**
 * `tools/corpus-harness/lexer-census.js` is the instrument behind DECISIONS §84's bar — every
 * flagged file read, and a mutation control that proves the lexer examines something. What can be
 * pinned without a corpus is pinned here. Loaded with `require`, the way the ceiling test reaches
 * `ceiling.js`: `tools/` is outside `tsconfig.json`'s `include`.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const census = require(path.join(__dirname, '..', '..', 'tools', 'corpus-harness', 'lexer-census.js')) as {
  EXTENSIONS: Record<string, string[]>;
  mutateLastCloser(content: string): string | null;
  lastCloserSite(content: string): { index: number; insideConditional: boolean; inMacro: boolean; inComment: boolean } | null;
  siteClass(site: { insideConditional: boolean; inMacro: boolean; inComment: boolean }): string;
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

  it('says whether the deleted line sits inside a conditional group', () => {
    // A brace inside `#ifdef __cplusplus` is not C: deleting it can leave valid C, and the census
    // reports those sites apart from the ones every configuration counts (§84).
    expect(census.lastCloserSite('#ifdef __cplusplus\nextern "C" {\n#endif\n#ifdef __cplusplus\n}\n#endif\n')).toMatchObject({
      index: 4,
      insideConditional: true,
    });
    expect(census.lastCloserSite('int f(void) {\n#ifdef X\n  g();\n#endif\n}\n')).toMatchObject({ index: 4, insideConditional: false });
    expect(census.lastCloserSite('int x;\n')).toBeNull();
  });

  it('treats an include guard as transparent — its body is unconditional (§84)', () => {
    expect(census.lastCloserSite('#ifndef A_H\n#define A_H\nstruct S {\n  int x;\n}\n#endif\n')).toMatchObject({
      index: 4,
      insideConditional: false,
    });
    expect(census.lastCloserSite('#ifndef A_H\n#define A_H\n#ifdef X\n}\n#endif\n#endif\n')).toMatchObject({
      index: 3,
      insideConditional: true,
    });
  });

  it('classes a macro continuation and a block comment apart from code (§84)', () => {
    // Both were among the census's first misses: a `}` that ends a multi-line `#define` is macro
    // text the lexer does not count, and one inside a comment is not code at all.
    const macro = census.lastCloserSite('#define M(x) { \\\n  f(x); \\\n}\nint y;\n')!;
    expect(census.siteClass(macro)).toBe('macro');
    const comment = census.lastCloserSite('/*\n  int f(void) {\n  }\n*/\nint y;\n')!;
    expect(census.siteClass(comment)).toBe('comment');
    expect(census.siteClass(census.lastCloserSite('int f(void) {\n  return 0;\n}\n')!)).toBe('code');
  });

  it('covers exactly the two languages R4 adds', () => {
    expect(census.EXTENSIONS).toEqual({ c: ['.c', '.h'], csharp: ['.cs'] });
  });
});

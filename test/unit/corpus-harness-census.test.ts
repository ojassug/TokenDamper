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
    expect(census.lastCloserSite('#ifndef A_H\n#define A_H\n#ifdef __cplusplus\n}\n#endif\n#endif\n')).toMatchObject({
      index: 3,
      insideConditional: true,
    });
  });

  it('counts a feature block with no #else as code — both configurations count it (§84)', () => {
    const site = census.lastCloserSite('int f(void) {\n#ifdef FEATURE\n  if (a) {\n  }\n#endif\n  return 0;\n}\n#ifdef REDIS_TEST\nint t(void) {\n}\n#endif\n')!;
    expect(site).toMatchObject({ index: 9, insideConditional: false });
    expect(census.siteClass(site)).toBe('code');
  });

  it('classes a branch a configuration can drop as conditional (§84)', () => {
    // A site is code only when both configurations count its branch: either side of an
    // #if/#else, a known-dead branch (__cplusplus, #if 0), and an #elif with no #else are not.
    expect(census.lastCloserSite('#if A\nint f(void) {\n}\n#else\nint g(void) {\n}\n#endif\n')).toMatchObject({ insideConditional: true });
    expect(census.lastCloserSite('#if 0\nint f(void) {\n}\n#endif\n')).toMatchObject({ insideConditional: true });
    expect(census.lastCloserSite('#ifdef A\nint f(void) {\n}\n#elif B\nint g(void) {\n}\n#endif\n')).toMatchObject({ insideConditional: true });
    expect(census.lastCloserSite('#if defined(__cplusplus)\n#elif A\n#else\nint g(void) {\n}\n#endif\n')).toMatchObject({ insideConditional: true });
    // #if 0 / #else: the #else is the only branch either configuration takes, so it is code.
    expect(census.lastCloserSite('#if 0\n#else\nint g(void) {\n}\n#endif\n')).toMatchObject({ insideConditional: false });
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

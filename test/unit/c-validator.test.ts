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
    ['a #if 0 block that is unbalanced and full of apostrophes', "#if 0\nit doesn't { matter\n#endif\nint x;\n"],
    ['the live #else of an #if 0', '#if 0\n  {\n#else\nint ok(void) { return 1; }\n#endif\n'],
    ['an apostrophe in #error', "#error don't build this\nint x;\n"],
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

describe('CValidator accepts a file that balances in some build configuration (§84 census)', () => {
  // Each case is the minimal shape of a real header the census flagged (DECISIONS §84): valid C,
  // and unbalanced under "the first branch of every group", which is all the first draft tried.
  it.each([
    [
      'an else-brace opened only in an #else branch (newapis.h)',
      'void f(int a) {\n#if defined(UNICODE)\n  g();\n#else\n  if (a) {\n    h();\n  } else {\n#endif\n    k();\n  }\n}\n',
    ],
    ['an extern "C" guard with no closer, valid as C (CPython)', '#ifdef __cplusplus\nextern "C" {\n#endif\nint x;\n'],
    ['__cplusplus tested with defined()', '#if defined(__cplusplus)\nextern "C" {\n#endif\nint x;\n'],
    ['C-only code under #ifndef __cplusplus', '#ifndef __cplusplus\nint f(void) { return 0; }\n#endif\n'],
    [
      '__cplusplus inside a conjunction (d3d11.h)',
      '#ifdef __cplusplus\nextern "C" {\n#endif\nint x;\n#if !defined(NO_HELPERS) && defined(__cplusplus)\n}\ninline int f(void) { return 0; }\nextern "C" {\n#endif\nint y;\n#ifdef __cplusplus\n}\n#endif\n',
    ],
    [
      'a macro defined only under __cplusplus, tested later (fterrors.h)',
      '#ifdef __cplusplus\n#define NEED_EXTERN_C\n  extern "C" {\n#endif\nint x;\n#ifdef NEED_EXTERN_C\n  }\n#endif\n',
    ],
  ])('%s', (_label, src) => {
    expect(verdict(src).issues).toEqual([]);
  });

  it('takes the #else after a known-false #if in the second configuration, as everywhere else', () => {
    // mimalloc's atomic.h: `#if defined(__cplusplus)` / `#elif …` / `#else`. The first
    // configuration counts the first live branch, the #elif; the second must count the #else, or
    // nothing ever reads it — and an #else-only opener balances only there.
    const src = 'void f(int a) {\n#if defined(__cplusplus)\n#elif defined(_WIN32)\n  g();\n#else\n  if (a) {\n    h();\n  } else {\n#endif\n    k();\n  }\n}\n';
    expect(verdict(src).issues).toEqual([]);
  });

  it('counts a feature block with no #else in both configurations, so damage inside it is caught', () => {
    // The second selection first excluded every block with no #else, which made all of them a
    // blind spot — 22% of the mutation sites in redis and curl sat inside one.
    expect(verdict('void f(int a) {\n#ifdef FEATURE\n  if (a) {\n    g();\n#endif\n}\n').valid).toBe(false);
  });

  it('never treats an include guard as a configuration choice — its body is always compiled', () => {
    // The census found the "last branch of every group" selection treating `#ifndef X_H` /
    // `#define X_H` / … / `#endif` as an empty #else, which made every guarded header balance
    // whatever it contained: deleting a brace inside one was caught 0.1% of the time.
    expect(verdict('#ifndef A_H\n#define A_H\nstruct S {\n  int x;\n#endif\n').valid).toBe(false);
    expect(verdict('#if !defined(A_H)\n#define A_H\nstruct S {\n  int x;\n#endif\n').valid).toBe(false);
    expect(verdict('#ifndef A_H\n#define A_H\nstruct S { int x; };\n#endif\n').valid).toBe(true);
  });

  it('still rejects a file that balances in no configuration', () => {
    expect(verdict('#if A\n{\n#else\n{\n#endif\nint x;\n').valid).toBe(false);
  });

  it('still rejects a split conditional in every configuration', () => {
    expect(codes('int x;\n#else\n}\n#endif\n')).toContain('AST_UNBALANCED_CONDITIONAL');
  });
});

describe('CValidator rejects these on purpose — the census counts them as false positives (§84)', () => {
  // Accepting them means excluding blocks that have no #else, which blinds the lexer to every
  // feature block. Characterization: if a change makes these pass, it has probably re-opened that.
  it.each([
    [
      'a namespace opened in an #elif and closed under a later #if (libstdc++ tr1)',
      'namespace std {\n#if USE_STD\n#elif defined(TR1)\nnamespace tr1 {\n#else\n#endif\n  int x;\n#if !USE_STD && defined(TR1)\n} // tr1\n#endif\n}\n',
    ],
    ['a broken line in a block nothing defines (sti.h)', 'struct S {\n#ifdef NOT_IMPLEMENTED\n  M(f(a) PURE;\n#endif\n};\n'],
  ])('%s', (_label, src) => {
    expect(verdict(src).valid).toBe(false);
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

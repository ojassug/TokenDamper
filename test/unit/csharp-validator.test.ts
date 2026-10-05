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
    ['an apostrophe in a #region name', "#region Don't touch\nclass A { }\n#endregion\n"],
    ['a #if false block that would not lex', '#if false\nit doesn\'t { even "parse\n#endif\nclass A { }\n'],
    ['attributes, generics and a verbatim identifier', '[Fact]\npublic void T(List<Dictionary<string, int>> @class) { }\n'],
    ['braces in comments', '// }\n/* {\n ( */\nclass A { }\n'],
    ['a body TokenDamper has elided', `class A {\n  int F() {${MARKER}}\n}\n`],
    ['CRLF line endings', 'class A\r\n{\r\n  void F() { }\r\n}\r\n'],
    // The census's first finding: 549 Newtonsoft.Json files open with a byte-order mark and then
    // `#region License`, and the BOM hid the `#` from line-start detection (§84).
    ['a byte-order mark before a #region', '﻿#region License\n// text\n#endregion\nclass A { }\n'],
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

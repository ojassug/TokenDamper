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

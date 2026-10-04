import { beforeAll, describe, expect, it } from 'vitest';
import { createDeepBackends, type DeepBackend } from '../../packages/deep/src/index';

/**
 * R4 — C and C# in the Deep backend (spec §4.3–§4.4). Every case fails against the unfixed
 * package, which has no `c` or `csharp` backend. Regions here are what `regions()` *offers*;
 * nothing in core can reach them until the region gate opens for these two languages (§86).
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
  it('is a backend this package carries', () => {
    expect(c?.language).toBe('c');
  });

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
  it('is a backend this package carries', () => {
    expect(cs?.language).toBe('csharp');
  });

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

describe('the R3 languages are untouched', () => {
  it('offers no definitions for them — their symbols mirror the shipped regex, not a declaration list', async () => {
    const all = new Map((await createDeepBackends()).map((b) => [b.language, b]));
    expect(all.get('typescript')!.definitions('export function a() { return 1; }\n')).toEqual([]);
  });
});

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDeepBackends } from '../../packages/deep/src/index';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import { createContextBundle, createContextItem } from '../../src/core/model/constructors';
import { deepOnlyBackend, isDeepOnlyLanguage } from '../../src/core/parser/deep-only';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import type { ParserAdapter } from '../../src/core/parser/types';

/**
 * R4 step 2 (spec §4.3, DECISIONS §85). C and C# take function symbols from their backend, in
 * deep mode only. Every assertion that a symbol appears fails against the unfixed engine; the
 * "does not move" cases are negative controls and pass on both.
 */
let backends: ParserAdapter[];
beforeAll(async () => {
  backends = (await createDeepBackends()) as unknown as ParserAdapter[];
});
afterEach(() => clearParserBackends());
const register = (): void => {
  for (const backend of backends) if (backend.language !== 'javascript') registerParserBackend(backend);
};

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

  it('deep mode takes the function from the backend, so deleting it is witnessed', () => {
    register();
    const deep = new DriftTracker({ engineMode: 'deep' });
    // The backend's names alone since §86 — §85 unioned them with the regex, whose `type:P`
    // survives any body elision and whose reading of C body code invented symbols.
    expect([...deep.extractItemSymbols(cItem)].sort()).toEqual(['fn:area']);

    const before = createContextBundle(C, 'file', 'a.c');
    const after = createContextBundle('struct P { int x; };\n', 'file', 'a.c');
    expect(deep.calculateDrift(before, after).driftScore).toBeGreaterThan(0);
    // The fast tracker, given the same deletion, witnesses nothing — what this step closes.
    expect(new DriftTracker().calculateDrift(before, after).driftScore).toBe(0);
  });

  it('does not move TypeScript, Python or Go in deep mode', () => {
    register();
    for (const [path, content] of [
      ['a.ts', 'export function a(){ return 1; }\n'],
      ['a.py', 'def a():\n    return 1\n'],
      ['a.go', 'package x\n\nfunc a() int {\n\treturn 1\n}\n'],
    ] as const) {
      const item = createContextItem({ id: 'x', kind: 'file', content, contentType: 'code', path });
      expect(new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(item)).toEqual(new DriftTracker().extractItemSymbols(item));
    }
  });
});

describe('drift symbols for C#', () => {
  it('deep mode adds qualified methods, so deleting one is witnessed', () => {
    register();
    const src = 'class K {\n  public int A(int x) { return x; }\n  int B() { return 2; }\n}\n';
    const before = createContextBundle(src, 'file', 'K.cs');
    const after = createContextBundle('class K {\n  public int A(int x) { return x; }\n}\n', 'file', 'K.cs');
    expect([...new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(before.items[0]!)].sort()).toContain('method:K.B');
    expect(new DriftTracker({ engineMode: 'deep' }).calculateDrift(before, after).driftScore).toBeGreaterThan(0);
  });
});

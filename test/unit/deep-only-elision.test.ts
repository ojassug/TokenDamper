import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDeepBackends } from '../../packages/deep/src/index';
import { loadConfig } from '../../src/config/load';
import { selectElisionRegions, splitRegionIntoStatements } from '../../src/core/elision/regions';
import { optimize } from '../../src/core/engine';
import { DriftTracker } from '../../src/core/ledger/drift-tracker';
import type { OptimizationRequest } from '../../src/core/model';
import { createContextBundle, createContextItem, createOptimizationBudget } from '../../src/core/model/constructors';
import { clearParserBackends, registerParserBackend } from '../../src/core/parser/registry';
import type { ParserAdapter } from '../../src/core/parser/types';
import { TOKENDAMPER_VERSION } from '../../src/version';

/**
 * R4 step 3 (DECISIONS §86): three things the first deep-mode measurement of C and C# found.
 * Every one cost reduction through a fail-open fallback, and one reached past the lexer:
 *
 *  1. **The shared regex reads C body code as declarations.** `struct curl_slist *list;` inside a
 *     function body yields `type:curl_slist`, which body elision then "loses" — 101 of curl's 126
 *     drift fallbacks. A deep-only item now takes its symbols from its backend alone.
 *  2. **A marker reads to the C# grammar as an attribute** (`[target: …]`), and with several in a
 *     namespaced file its error recovery turns the whole namespace into one ERROR node, so every
 *     method name "vanishes" — most of jellyfin's 131 drift fallbacks. Markers are stripped before
 *     the backend reads symbols; a region that swallowed a header still loses the name.
 *  3. **Statement division crossed a preprocessor line.** It elided an `#if` and left its `#endif`
 *     glued to a marker, where no lexer sees a directive. A C or C# body holding a directive is
 *     no longer divided.
 *
 * Each case below fails against the engine before §86, except the ones marked as controls.
 */
let backends: ParserAdapter[];
beforeAll(async () => {
  backends = (await createDeepBackends()) as unknown as ParserAdapter[];
});
afterEach(() => clearParserBackends());
const register = (): void => {
  for (const backend of backends) if (backend.language !== 'javascript') registerParserBackend(backend);
};
const MARKER = '[TokenDamper: 10 function-body lines elided, 410 bytes, sha256:47a9c7530a07]';

describe('drift symbols for a deep-only item come from its backend alone (§86)', () => {
  it('ignores a struct local the shared regex reads as a type declaration (curl)', () => {
    register();
    const src = 'int main(void) {\n  struct curl_slist *list = NULL;\n  return 0;\n}\n';
    const item = createContextItem({ id: 'c', kind: 'file', content: src, contentType: 'code', path: 'a.c' });
    expect([...new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(item)]).toEqual(['fn:main']);
  });

  it('reads method names through markers the C# grammar takes for attributes (jellyfin)', () => {
    register();
    const method = (name: string): string => `        public void ${name}(int value)\n        {${MARKER}}\n`;
    const names = ['Add', 'Remove', 'Find', 'Create', 'Collapse', 'Ensure'];
    const src =
      'using System;\nusing System.Linq;\n\nnamespace Jelly.Server.Collections\n{\n' +
      '    public class CollectionManager : ICollectionManager\n    {\n' +
      names.map(method).join('\n') +
      '    }\n}\n';
    const item = createContextItem({ id: 'k', kind: 'file', content: src, contentType: 'code', path: 'K.cs' });
    expect([...new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(item)].sort()).toEqual(
      names.map((n) => `method:CollectionManager.${n}`).sort(),
    );
  });

  it('control: fast mode and the R3 languages keep the shared regex', () => {
    register();
    const c = createContextItem({ id: 'c', kind: 'file', content: 'struct P { int x; };\n', contentType: 'code', path: 'a.c' });
    expect([...new DriftTracker().extractItemSymbols(c)]).toEqual(['type:P']);
    const ts = createContextItem({ id: 't', kind: 'file', content: 'export class A {}\n', contentType: 'code', path: 'a.ts' });
    expect(new DriftTracker({ engineMode: 'deep' }).extractItemSymbols(ts)).toEqual(new DriftTracker().extractItemSymbols(ts));
  });
});

describe('a deep-only item is never elided whole in deep mode (§86)', () => {
  // Prototypes and nothing else: no region, no backend symbol. Whole-item elision of it can only
  // end in the measurement gate's refusal (§33), so attempting it manufactures a fallback.
  // `#pragma once` rather than an include guard on purpose: the shared regex's Python `def` rule
  // reads `#ifndef X_H` as `fn:X_H`, a phantom that made a guarded header look symbol-bearing.
  const HEADER =
    '#pragma once\n\n' +
    Array.from({ length: 12 }, (_, k) => `void clusterSlotStatsReset${k}(int slot, long long value);\n`).join('');
  const request = (): OptimizationRequest => ({
    requestId: 'deep-only-whole-item',
    rawInput: HEADER,
    bundle: createContextBundle(HEADER, 'file', 'cluster_slot_stats.h'),
    budget: createOptimizationBudget({ targetReductionRatio: 0.3 }),
    config: loadConfig({ env: {} }),
    adapterName: 'test',
    adapterVersion: TOKENDAMPER_VERSION,
  });

  it('leaves a header of prototypes untouched, with no fallback', () => {
    register();
    const result = optimize(request(), { engineMode: 'deep' });
    expect(result.emittedOutput).toBe(HEADER);
    expect(result.trace.fallbackUsed).toBe(false);
  });
});

describe('statement division never crosses a preprocessor line in C or C# (§86)', () => {
  // Long enough that each statement clears MIN_REGION_BYTES (104) on its own, or division finds
  // nothing usable whatever the directives do.
  const STATEMENT =
    '            total = total + ComputeAreaOfRectangleWithMargins(widthInUnits, heightInUnits, scaleFactor, offset, marginLeft, marginRight);\n';
  const src =
    'class K\n{\n    int F(int widthInUnits, int heightInUnits, int scaleFactor, int offset)\n    {\n        int total = 0;\n' +
    `#if HAVE_LINQ\n${STATEMENT.repeat(3)}#endif\n${STATEMENT.repeat(3)}` +
    '        return total;\n    }\n}\n';
  const item = createContextItem({ id: 'k', kind: 'file', content: src, contentType: 'code', path: 'K.cs' });

  it('does not divide a body that holds #if', () => {
    register();
    const [region] = selectElisionRegions(item, { mode: 'deep' });
    expect(region).toBeDefined();
    expect(splitRegionIntoStatements(item, region!, { mode: 'deep' })).toEqual([]);
  });

  it('control: still divides the same body without the directives', () => {
    register();
    const plain = src.replace('#if HAVE_LINQ\n', '').replace('#endif\n', '');
    const plainItem = createContextItem({ id: 'k', kind: 'file', content: plain, contentType: 'code', path: 'K.cs' });
    const [region] = selectElisionRegions(plainItem, { mode: 'deep' });
    expect(splitRegionIntoStatements(plainItem, region!, { mode: 'deep' }).length).toBeGreaterThan(1);
  });
});

describe('statement division keeps a compound statement whole in C and C# (§86)', () => {
  // The splitter ended a span at any `}` returning depth to 0, so `if {…}` and `else {…}` were two
  // spans; eliding the first left `else` attached to a marker. Measured on jellyfin, a C# grammar
  // re-reading that output loses the enclosing class and reads every method in it as gone.
  // Each case fails against the unfixed splitter; the do-while one is `WebSocketConnection.cs`.
  const CALL = 'ComputeAreaOfRectangleWithMargins(widthInUnits, heightInUnits, scaleFactor, offset, marginLeft, marginRight);\n';
  const tail = `            total = total + ${CALL}`.repeat(3) + '            return total;\n';
  const wrapCs = (body: string): string =>
    'class K\n{\n    int F(int widthInUnits, int heightInUnits, int scaleFactor, int offset)\n    {\n' +
    `            int total = 0;\n${body}${tail}    }\n}\n`;
  const wrapC = (body: string): string =>
    `int f(int widthInUnits, int heightInUnits, int scaleFactor, int offset)\n{\n  int total = 0;\n${body}${tail}}\n`;

  /** The continuation words left at the start of the text after a span, for each span that has one. */
  const orphans = (content: string, path: string, mode: 'fast' | 'deep'): string[] => {
    const item = createContextItem({ id: 'x', kind: 'file', content, contentType: 'code', path });
    const [region] = selectElisionRegions(item, { mode });
    expect(region).toBeDefined();
    const spans = splitRegionIntoStatements(item, region!, { mode });
    expect(spans.length).toBeGreaterThan(1); // or the test is vacuous: an undivided body orphans nothing
    return spans
      .map((span) => /^\s*(else|catch|finally|while)\b/.exec(content.slice(span.end, region!.end))?.[1])
      .filter((word): word is string => word !== undefined);
  };

  it('C: an else on its own line stays with its if', () => {
    register();
    const body = `  if(widthInUnits > heightInUnits) {\n    total = total + ${CALL}  }\n  else {\n    total = total - ${CALL}  }\n`;
    expect(orphans(wrapC(body), 'a.c', 'deep')).toEqual([]);
  });

  it('C: a braceless if keeps its else', () => {
    register();
    const body = `  if(widthInUnits > heightInUnits)\n    total = total + ${CALL}  else\n    total = total - ${CALL}`;
    expect(orphans(wrapC(body), 'a.c', 'deep')).toEqual([]);
  });

  it('C#: try keeps its catch and finally', () => {
    register();
    const body =
      `            try\n            {\n                total = total + ${CALL}            }\n` +
      `            catch (InvalidOperationException ex) when (ex.Message.Length > 0)\n            {\n                total = total - ${CALL}            }\n` +
      `            finally\n            {\n                total = total * ${CALL}            }\n`;
    expect(orphans(wrapCs(body), 'K.cs', 'deep')).toEqual([]);
  });

  it('C#: a do block keeps its while (the jellyfin case)', () => {
    register();
    const body = `            do\n            {\n                total = total + ${CALL}            }\n            while (total < widthInUnits * heightInUnits && scaleFactor > 0);\n`;
    expect(orphans(wrapCs(body), 'K.cs', 'deep')).toEqual([]);
  });

  it('control: a while loop after a do-while is still its own statement', () => {
    register();
    const body =
      `            do\n            {\n                total = total + ${CALL}            }\n            while (total < widthInUnits);\n` +
      `            while (total > heightInUnits)\n            {\n                total = total - ${CALL}            }\n`;
    const item = createContextItem({ id: 'k', kind: 'file', content: wrapCs(body), contentType: 'code', path: 'K.cs' });
    const [region] = selectElisionRegions(item, { mode: 'deep' });
    const texts = splitRegionIntoStatements(item, region!, { mode: 'deep' }).map((s) => item.content.slice(s.start, s.end));
    expect(texts.some((t) => /^\s*while \(total > heightInUnits\)/.test(t))).toBe(true);
  });
  // TypeScript and Python carry the same rule; their cases are in sub-region-elision.test.ts.
});

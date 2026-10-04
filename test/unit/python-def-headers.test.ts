import { describe, expect, it } from 'vitest';
// Source, not `dist` — the same choice `deep-backend-regions.test.ts` makes, for the same reason.
import { createDeepBackends } from '../../packages/deep/src/index';
import { DEFAULT_CONFIG } from '../../src/config/schema';
import { elideRegions, selectElisionRegions, type SelectRegionsOptions } from '../../src/core/elision';
import { optimize } from '../../src/core/engine';
import { TokenHasher } from '../../src/core/hashing/token-hasher';
import { createContextItem, createOptimizationRequest } from '../../src/core/model/constructors';
import { validateItemAst } from '../../src/core/validation/ast';

/**
 * The Fast Python scanner recognised a `def` header only when it was written on one line and
 * began with `def` (DECISIONS §82, "Found off the R4 path"; fixed in §83).
 *
 * Every black-wrapped signature and every `async def` was skipped. On the frozen pip 26.2.1
 * corpus that put the Fast ceiling at 43.23% against Deep's 67.90%, and `cli/req_command.py`
 * alone at 8.4% against 76.4%.
 *
 * **Against the unfixed scanner, the `selects` block, the round trip, `--keep-docstrings`, the
 * end-to-end run and the Deep agreement all fail.** The negative controls pass there, with
 * one exception. They assert an *absence*, and the old scanner selected nothing wrapped at all.
 * They guard the widened scanner against over-selection; they are not evidence that it works.
 * The exception is the one-line `def` inside a triple-quoted string. The old one-line rule
 * matched that too, so the control fails against the unfixed scanner as well. The lexical
 * state the wrapped case needs is what closes it.
 */

const pyItem = (content: string) =>
  createContextItem({ id: 'py', kind: 'file', contentType: 'code', content, path: 'req_command.py', language: 'python' });

const regionsOf = (content: string, options?: SelectRegionsOptions) => selectElisionRegions(pyItem(content), options);

/**
 * A body well clear of `MIN_REGION_BYTES` (104). A fixture under the floor tests the floor,
 * not the scanner. It is code only, with no comment or docstring for the constraint gate or
 * the substantive-region guard to act on.
 */
const body = (indent: string): string =>
  [
    `${indent}resolver = build_resolver(preparer, finder, options)`,
    `${indent}for requirement in requirements:`,
    `${indent}    resolver.add(requirement.name, requirement.specifier)`,
    `${indent}return resolver.resolve(check_supported_wheels=True)`,
  ].join('\n');

/**
 * What a correct scanner selects: from the first statement to the end of the last body line.
 * The first line's indentation stays outside the region, so the marker inherits the body's
 * column and `PythonValidator` sees no `AST_INDENTATION_ERROR` (Rule B).
 */
const bodyText = (indent: string): string => body(indent).slice(indent.length);

function expectOnlyTheBody(src: string, indent: string): void {
  const found = regionsOf(src);
  expect(found).toHaveLength(1);
  expect(src.slice(found[0]!.start, found[0]!.end)).toBe(bodyText(indent));
  expect(src.slice(found[0]!.start - indent.length, found[0]!.start)).toBe(indent);
}

const WRAPPED = ['def make_resolver(', '    preparer,', '    finder,', '    options,', ') -> BaseResolver:'];

describe('the Fast Python scanner selects bodies under wrapped and async headers', () => {
  it('selects the body under a signature wrapped across lines', () => {
    expectOnlyTheBody([...WRAPPED, body('    '), ''].join('\n'), '    ');
  });

  it('selects a method body under a black-wrapped signature, leaving the class and decorator alone', () => {
    const src = [
      'class RequirementCommand(IndexGroupCommand):',
      '    @staticmethod',
      '    def make_resolver(',
      '        preparer: RequirementPreparer,',
      '        finder: PackageFinder,',
      '        options: Values,',
      '    ) -> BaseResolver:',
      body('        '),
      '',
    ].join('\n');
    expectOnlyTheBody(src, '        ');
  });

  it('selects an async def body', () => {
    expectOnlyTheBody(['async def fetch(session, url):', body('    '), ''].join('\n'), '    ');
  });

  it('selects the body under a wrapped async def with a return annotation', () => {
    const src = [
      'async def fetch_all(',
      '    session: ClientSession,',
      '    urls: list[str],',
      ') -> dict[str, bytes]:',
      body('    '),
      '',
    ].join('\n');
    expectOnlyTheBody(src, '    ');
  });

  it('follows a return annotation that is itself wrapped', () => {
    const src = [
      'def get_installation_order(',
      '    self,',
      '    req_set: RequirementSet,',
      ') -> Dict[',
      '    str,',
      '    List[InstallRequirement],',
      ']:',
      body('    '),
      '',
    ].join('\n');
    expectOnlyTheBody(src, '    ');
  });

  it('resumes after one wrapped header and finds the next', () => {
    const src = [
      'class RequirementCommand(IndexGroupCommand):',
      '    def make_requirement_preparer(',
      '        temp_build_dir: TempDirectory,',
      '        options: Values,',
      '    ) -> RequirementPreparer:',
      body('        '),
      '',
      '    async def make_resolver(',
      '        preparer: RequirementPreparer,',
      '    ) -> BaseResolver:',
      body('        '),
      '',
    ].join('\n');
    const found = regionsOf(src);

    expect(found).toHaveLength(2);
    for (const region of found) {
      expect(src.slice(region.start, region.end)).toBe(bodyText('        '));
    }
  });

  it("starts at the first non-blank body line after the header's last line (audit L7)", () => {
    expectOnlyTheBody([...WRAPPED, '', body('    '), ''].join('\n'), '    ');
  });

  it('ends the header where the parameter list closes, not at the first line ending in a colon', () => {
    // A comment ending in `:` inside the parameter list, and a string default holding `)` and
    // `:`. Stopping at the first line that ends with a colon would start the "body" at
    // `sep: str = ...`. Counting brackets without reading strings would close the list inside
    // `"):"` and find no header at all.
    const src = [
      'def render(',
      '    template,  # the template name:',
      '    sep: str = "):",',
      '    width=80,',
      ') -> str:',
      body('    '),
      '',
    ].join('\n');
    expectOnlyTheBody(src, '    ');
  });

  it('handles a CRLF file, ending the region on the last body line’s `\\r` as the one-line rule does', () => {
    // Converted whole: `body()` joins its own lines, so joining the outer array with `\r\n`
    // would build a mixed file.
    const src = [...WRAPPED, body('    '), ''].join('\n').replace(/\n/g, '\r\n');
    const found = regionsOf(src);

    expect(found).toHaveLength(1);
    // `lineAt(last).end` is the `\n`'s offset, so the region keeps the `\r` before it — the same
    // convention `deep-backend-regions.test.ts` pins for one-line headers.
    expect(src.slice(found[0]!.start, found[0]!.end)).toBe(bodyText('    ').replace(/\n/g, '\r\n') + '\r');
  });

  it("keeps a docstring under a wrapped header outside the region when asked (§58)", () => {
    const src = [...WRAPPED, '    """Build the resolver for this command."""', body('    '), ''].join('\n');

    const kept = regionsOf(src, { keepDocstrings: true });
    expect(kept).toHaveLength(1);
    expect(src.slice(kept[0]!.start, kept[0]!.end)).toBe(bodyText('    '));
  });
});

describe('a wrapped header’s region is safe to elide', () => {
  it('produces output the validator accepts and the hasher restores byte for byte', () => {
    const src = [...WRAPPED, body('    '), ''].join('\n');
    const target = pyItem(src);
    const hasher = new TokenHasher();
    const outcome = elideRegions({
      item: target,
      regions: selectElisionRegions(target),
      markerFor: (text) => hasher.createBlockPlaceholder(text),
      metadata: { elided: true, tokenHashed: true },
    });

    expect(outcome.status).toBe('elided');
    if (outcome.status !== 'elided') return;
    // The whole signature survives, which is why drift can still see the function.
    expect(outcome.item.content.startsWith(WRAPPED.join('\n'))).toBe(true);
    expect(validateItemAst(outcome.item).valid).toBe(true);
    expect(hasher.rehydrateText(outcome.item.content)).toBe(src);
  });

  it('reduces a module of wrapped methods end to end, with no fallback', () => {
    const method = (name: string, asyncDef = false) => [
      `    ${asyncDef ? 'async ' : ''}def ${name}(`,
      '        self,',
      '        preparer: RequirementPreparer,',
      '        finder: PackageFinder,',
      '    ) -> BaseResolver:',
      body('        '),
      '',
    ];
    const names = ['make_resolver', 'make_preparer', 'make_finder', 'make_session'];
    const source = [
      'from pip._internal.index.package_finder import PackageFinder',
      'from pip._internal.operations.prepare import RequirementPreparer',
      '',
      '',
      'class RequirementCommand(IndexGroupCommand):',
      ...names.flatMap((name, i) => method(name, i % 2 === 1)),
    ].join('\n');

    const request = createOptimizationRequest(
      source,
      { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, targetReductionRatio: 0.3 } },
      {
        requestId: 'r',
        adapterName: 'test',
        adapterVersion: '1',
        source: 'file',
        sourcePath: 'req_command.py',
        language: 'python',
      },
    );
    const result = optimize(request, {});

    expect(result.fallbackUsed).toBe(false);
    expect(result.trace.tokenAfter).toBeLessThan(result.trace.tokenBefore);
    for (const name of names) {
      expect(result.emittedOutput).toContain(`def ${name}(`);
    }
  });
});

describe('Fast and Deep agree on these headers', () => {
  // Deep's raw `regions()` has no size or substantive filter, so each fixture holds exactly
  // one function and its body clears the floor. Anything else would compare the filter rather
  // than the discovery.
  const cases = [
    { name: 'wrapped def', content: [...WRAPPED, body('    '), ''].join('\n') },
    { name: 'async def', content: ['async def fetch(session, url):', body('    '), ''].join('\n') },
    {
      name: 'wrapped async def with a return annotation',
      content: ['async def fetch_all(', '    session: ClientSession,', ') -> dict[str, bytes]:', body('    '), ''].join(
        '\n',
      ),
    },
    {
      name: 'decorated method with a wrapped signature',
      content: [
        'class RequirementCommand(IndexGroupCommand):',
        '    @staticmethod',
        '    def make_resolver(',
        '        preparer: RequirementPreparer,',
        '    ) -> BaseResolver:',
        body('        '),
        '',
      ].join('\n'),
    },
  ];

  it.each(cases)('$name', async ({ content }) => {
    const backends = await createDeepBackends();
    const py = backends.find((b) => b.language === 'python')!;

    const fast = regionsOf(content).map(({ start, end }) => ({ start, end }));
    const deep = py.regions(content).map(({ start, end }) => ({ start, end }));

    expect(fast).toHaveLength(1);
    expect(deep).toEqual(fast);
  });
});

describe('negative controls: none of these is a function body', () => {
  it('opens no header on a wrapped def inside a triple-quoted string', () => {
    const src = ['TEMPLATE = """', 'def generated(', '    preparer,', '    finder,', '):', body('    '), '"""', ''].join(
      '\n',
    );
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('opens no header on a one-line def inside a triple-quoted string (fails on the unfixed scanner too)', () => {
    // The old `^\s*def\s.*:\s*$` test is line-local, so it matched this and elided part of a
    // string literal. Every gate passes when that happens: the marker sits inside a string, so
    // the validator cannot see it, and the `def` line survives, so drift sees no loss.
    const src = ['TEMPLATE = """', 'def generated(preparer, finder):', body('    '), '"""', ''].join('\n');
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('opens no header on a commented-out def, wrapped or async', () => {
    const src = [
      '# def make_resolver(',
      '#     preparer,',
      '# ) -> BaseResolver:',
      ...body('    ')
        .split('\n')
        .map((line) => `# ${line}`),
      '# async def fetch(session, url):',
      ...body('    ')
        .split('\n')
        .map((line) => `# ${line}`),
      '',
    ].join('\n');
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('never selects a class body, even under a wrapped class header', () => {
    const src = [
      'class LinkCandidate(',
      '    _InstallRequirementBackedCandidate,',
      '    metaclass=abc.ABCMeta,',
      '):',
      '    is_editable = False',
      '    supported_tags = frozenset(sys_tags())',
      '    source_link = Link("https://files.pythonhosted.org/packages/source.tar.gz")',
      '    default_timeout = DEFAULT_TIMEOUT_SECONDS * RETRY_MULTIPLIER',
      '',
    ].join('\n');
    expect(src.length).toBeGreaterThan(200);
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('selects nothing under a parameter list that never closes, and does not throw', () => {
    // Truncated input: an editor buffer or a cut-off paste.
    const src = ['def make_resolver(', '    preparer,', '    finder,', body('    ')].join('\n');
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('selects nothing when the body sits on the closing line', () => {
    const src = ['def make_resolver(', '    preparer,', `): return build_resolver(preparer, ${'finder, '.repeat(12)}options)`, ''].join(
      '\n',
    );
    expect(regionsOf(src)).toHaveLength(0);
  });

  it('still closes a one-line header whose string default or comment holds a bracket', () => {
    // Passes on the unfixed scanner. It guards the widened one: a lexer that does not read
    // strings and comments would count `((` and `(` below as open, run the header on into the
    // body, and lose a region the one-line rule has always found.
    expectOnlyTheBody(['def split_marker(text, marker="(("):', body('    '), ''].join('\n'), '    ');
    expectOnlyTheBody(['def split_marker(text):  # see split_marker(:', body('    '), ''].join('\n'), '    ');
  });
});

/**
 * Which grammar answers for which language, and where its WASM lives.
 *
 * The first four are the four the shipped Fast path identifies (R3, whose deliverable was that
 * a second backend reproduces the first where the answer can still be hand-checked). C and C#
 * are R4's: §82 measured both above the 40% floor on two corpora each, and they are
 * **deep-only** — core names them through its Fast lexers but has no region scanner for either.
 */
export type DeepLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'c' | 'csharp';

export const DEEP_LANGUAGES: ReadonlyArray<DeepLanguage> = Object.freeze([
  'typescript',
  'javascript',
  'python',
  'go',
  'c',
  'csharp',
]);

/**
 * `require.resolve` rather than a path built from `__dirname`.
 *
 * Every one of these packages lists `*.wasm` in its `files`, so the artifact is resolvable by
 * specifier wherever the package is installed — hoisted to a workspace root, nested, or
 * pnpm-linked. Computing `../../node_modules/...` from here would work in this repository and
 * break in any other layout, and would do so at *load* time rather than visibly.
 */
const WASM_SPECIFIERS: Readonly<Record<DeepLanguage, string>> = Object.freeze({
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  go: 'tree-sitter-go/tree-sitter-go.wasm',
  c: 'tree-sitter-c/tree-sitter-c.wasm',
  csharp: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
});

export function grammarWasmPath(language: DeepLanguage): string {
  return require.resolve(WASM_SPECIFIERS[language]);
}

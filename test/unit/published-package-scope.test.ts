import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The published package must not carry the test suite.
 *
 * `npm run build` used `tsconfig.json`, which covers `src/` **and** `test/` because
 * `npm run typecheck` wants it to — a type error in a test is a real error. But the build shared
 * that config, so `tsc` emitted `dist/test/` too, and `package.json` `files` ships all of `dist`.
 * Measured before the split: **285 of the tarball's 508 entries** were compiled suites, 46% of its
 * unpacked bytes, against 210 entries for the product itself.
 *
 * This is a config test rather than a `npm pack` test on purpose. Packing needs a completed build,
 * which makes it slow and makes its result depend on whatever `dist/` happens to hold — including
 * a stale `dist/test/` from a checkout that built before this change. The configuration is the
 * thing that has to stay true.
 */
describe('the published package ships the product, not the suite', () => {
  const repoRoot = join(__dirname, '..', '..');
  const readJson = (name: string): Record<string, unknown> => {
    // `tsconfig*.json` is JSONC — strip line comments before parsing. Block comments are not used.
    const raw = readFileSync(join(repoRoot, name), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(raw) as Record<string, unknown>;
  };

  it('builds from a config that emits only src/', () => {
    const build = readJson('tsconfig.build.json');
    expect(build.extends).toBe('./tsconfig.json');
    expect(build.include).toEqual(['src/**/*.ts']);
    expect(JSON.stringify(build.include)).not.toContain('test');
  });

  it('points the build script at it — the config is inert if nothing runs it', () => {
    // Invariant 10: the assertion above passes just as well against a repository that has this
    // file and never uses it.
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toBe('tsc -p tsconfig.build.json');
  });

  it('keeps typecheck on the wider config, so tests stay type-checked', () => {
    // The point of the split is that only *emission* narrows. Losing type coverage of the suite
    // would be a real regression: it is what catches a bad generic in a test that vitest runs
    // green.
    const pkg = readJson('package.json') as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toBe('tsc -p tsconfig.json --noEmit');

    const base = readJson('tsconfig.json');
    expect(base.include).toContain('test/**/*.ts');
  });

  it('inherits an explicit rootDir, without which the output would silently relocate', () => {
    // `rootDir: "."` is what keeps emission at `dist/src/...`. Unset, `tsc` infers the common root
    // of the input set — which for a src-only include is `src/`, moving every file up one level
    // and breaking `main`, `types` and `bin` in a build that still succeeds.
    const base = readJson('tsconfig.json') as { compilerOptions: Record<string, unknown> };
    expect(base.compilerOptions.rootDir).toBe('.');
    expect(base.compilerOptions.outDir).toBe('dist');

    const pkg = readJson('package.json') as { main: string; types: string; bin: Record<string, string> };
    for (const entry of [pkg.main, pkg.types, ...Object.values(pkg.bin)]) {
      expect(entry, `entry point ${entry} assumes the dist/src/ layout`).toContain('dist/src/');
    }
  });

  it('ships dist wholesale, which is why the build config is the control', () => {
    // If `files` ever enumerated `dist/src` directly, this whole split would be unnecessary — and
    // the reverse is the risk worth pinning: it ships `dist`, so anything emitted is published.
    const pkg = readJson('package.json') as { files: string[] };
    expect(pkg.files).toContain('dist');
    expect(pkg.files.some((f) => f.startsWith('dist/'))).toBe(false);
  });
});

/**
 * 2.0.0 publishes `packages/deep` as its own package (DECISIONS §87). Core keeps zero runtime
 * dependencies — the grammars and `web-tree-sitter` are the deep package's — and the two version
 * in lockstep, so `tokendamper-deep@X` is always the backend `tokendamper@X` was measured with.
 */
describe('tokendamper-deep is a separate, publishable package (2.0.0)', () => {
  const repoRoot = join(__dirname, '..', '..');
  type Manifest = {
    private?: boolean;
    version: string;
    files?: string[];
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  const read = (p: string): Manifest => JSON.parse(readFileSync(join(repoRoot, p), 'utf8')) as Manifest;
  const core = read('package.json');
  const deep = read('packages/deep/package.json');

  it('is public, and versioned in lockstep with core', () => {
    expect(deep.private).toBeUndefined();
    expect(deep.version).toBe(core.version);
  });

  it('ships its build, README and LICENSE only', () => {
    expect(deep.files).toEqual(['dist', 'README.md', 'LICENSE']);
    expect(existsSync(join(repoRoot, 'packages/deep/README.md'))).toBe(true);
    expect(readFileSync(join(repoRoot, 'packages/deep/LICENSE'))).toEqual(readFileSync(join(repoRoot, 'LICENSE')));
  });

  it('declares core as an optional peer, so a workspace install never fetches an unpublished core', () => {
    expect(deep.peerDependencies?.tokendamper).toBe(`^${String(core.version).split('.')[0]}.0.0`);
    expect(deep.peerDependenciesMeta?.tokendamper?.optional).toBe(true);
  });

  it('keeps core free of runtime dependencies and of packages/', () => {
    expect(core.dependencies).toBeUndefined();
    expect((core.files ?? []).some((f) => f.startsWith('packages'))).toBe(false);
  });
});

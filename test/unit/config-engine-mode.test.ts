import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load';
import { runCli } from '../../src/cli/main';

const dirWith = (config?: object) => {
  const d = mkdtempSync(join(tmpdir(), 'tokendamper-engine-'));
  writeFileSync(join(d, 'a.ts'), 'export const a = 1;\n', 'utf8');
  if (config) writeFileSync(join(d, 'tokendamper.config.json'), JSON.stringify(config), 'utf8');
  return d;
};

const streams = () => {
  let err = '';
  const stderr = new PassThrough();
  stderr.on('data', (c) => (err += String(c)));
  const stdout = new PassThrough();
  stdout.resume();
  return {
    io: { stdout, stderr },
    get err() {
      return err;
    },
  };
};

describe('engine.mode (DECISIONS §87)', () => {
  it('defaults to fast', () => {
    expect(loadConfig({ cwd: dirWith(), env: {} }).engineMode).toBe('fast');
  });

  it('reads the file, then the environment, then the CLI', () => {
    const cwd = dirWith({ engine: { mode: 'deep' } });
    expect(loadConfig({ cwd, env: {} }).engineMode).toBe('deep');
    expect(loadConfig({ cwd, env: { TOKENDAMPER_ENGINE_MODE: 'fast' } }).engineMode).toBe('fast');
    expect(loadConfig({ cwd, env: {}, cliOverrides: { engineMode: 'fast' } }).engineMode).toBe('fast');
  });

  it('rejects an unrecognised value from any door', () => {
    expect(() => loadConfig({ cwd: dirWith(), env: { TOKENDAMPER_ENGINE_MODE: 'turbo' } })).toThrow(
      /Accepted values: fast, deep/,
    );
    expect(() => loadConfig({ cwd: dirWith({ engine: { mode: 'turbo' } }), env: {} })).toThrow(
      /Invalid TokenDamper config file/,
    );
  });

  it('carries --mode through the config layers, so the flag outranks the file', () => {
    const cwd = dirWith({ engine: { mode: 'deep' } });
    const s = streams();
    // The exit code alone cannot tell: in a checkout with the deep package built, a wrong
    // precedence would load backends and still exit 0. The trace says which engine ran.
    expect(runCli(['optimize', join(cwd, 'a.ts'), '--mode', 'fast'], s.io, cwd)).toBe(0);
    const trace = JSON.parse(s.err.slice(s.err.indexOf('{'), s.err.lastIndexOf('}') + 1)) as {
      parserCoverage?: { mode?: string };
    };
    expect(trace.parserCoverage?.mode).toBe('fast');
  });
});

describe('app.mode is a withdrawn key (2.0.0)', () => {
  it('still loads, with a notice naming the replacement', () => {
    const config = loadConfig({ cwd: dirWith({ app: { mode: 'bench' } }), env: {} });
    expect(config.notices.join('\n')).toMatch(/app\.mode was withdrawn in 2\.0\.0/);
  });

  it('accepts any value it used to reject, because nothing reads it', () => {
    expect(() => loadConfig({ cwd: dirWith({ app: { mode: 'explain' } }), env: {} })).not.toThrow();
  });

  it('treats TOKENDAMPER_APP_MODE the same way', () => {
    const config = loadConfig({ cwd: dirWith(), env: { TOKENDAMPER_APP_MODE: 'optimize' } });
    expect(config.notices.join('\n')).toMatch(/TOKENDAMPER_APP_MODE was withdrawn in 2\.0\.0/);
  });

  it('carries no notice when neither is set', () => {
    expect(loadConfig({ cwd: dirWith(), env: {} }).notices).toEqual([]);
  });

  it('writes the notice to stderr once per run', () => {
    const cwd = dirWith({ app: { mode: 'optimize' } });
    const s = streams();
    expect(runCli(['optimize', join(cwd, 'a.ts')], s.io, cwd)).toBe(0);
    expect(s.err.match(/app\.mode was withdrawn/g)).toHaveLength(1);
  });
});

describe('a resolved deep engine on bench or mcp is refused (invariant 10)', () => {
  it.each(['bench', 'mcp'])('%s', (command) => {
    const cwd = dirWith({ engine: { mode: 'deep' } });
    const s = streams();
    expect(runCli([command], s.io, cwd)).toBe(1);
    expect(s.err).toContain(`${command} runs the fast engine only`);
    expect(s.err).toContain('TOKENDAMPER_ENGINE_MODE=fast');
  });
});

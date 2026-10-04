import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli, SUPPORTED_FLAGS } from '../../../src/cli/main';
import { loadConfig } from '../../../src/config/load';

/**
 * `--trace-output` and `--mode explain` are withdrawn — audit OX-H5.
 *
 * Both were parsed, validated, stored on `ResolvedConfig`, and read by **nothing**. The trace is
 * written with a literal `io.stderr.write(...)`, so `--trace-output stdout` reported success and
 * changed nothing; a caller redirecting to capture a trace in a pipe got stderr anyway and
 * concluded the tool had ignored them, which it had. Nothing branches on `appMode === 'explain'`
 * either — it stored a string.
 *
 * This is the defect audit H4 already removed three flags for (`--max-output-tokens`,
 * `--max-latency-ms`, `--risk-tolerance`, README "removed in 1.2.0"). These two survived that
 * sweep. Withdrawn on the same terms and for the same reason: **the surfaces go, the model fields
 * stay**, because `ARCHITECTURE.md` pins the model as frozen and a field awaiting an
 * implementation is not the same thing as a dial that reports success.
 *
 * The two halves that are *not* withdrawn are pinned here as well, because they are what makes
 * this a withdrawal rather than a deletion.
 *
 * **2.0.0 withdrew the rest of `--mode`'s old values, and `--engine-mode` with them** (DECISIONS
 * §87). `--mode` now selects the engine, `fast|deep`; `test/unit/cli/mode-flag.test.ts` pins the
 * parse errors that name each replacement.
 */
describe('withdrawn dead knobs', () => {
  const io = () => {
    const err: string[] = [];
    const streams = {
      stdout: new PassThrough(),
      stderr: { write: (c: unknown) => { err.push(String(c)); return true; } } as never,
    };
    streams.stdout.resume();
    return { err, io: streams };
  };

  // A real file rather than `-`. Stdin blocks on `readFileSync(0)` in a test runner, and it
  // blocks precisely on the path where the flag is still *accepted* — so a stdin-based test
  // hangs instead of failing, which is the least useful way for a red test to be red.
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'tokendamper-withdrawn-'));
    writeFileSync(join(d, 'a.ts'), 'export const alpha = 1;\n', 'utf8');
    return d;
  };
  const input = (d: string) => join(d, 'a.ts');

  describe('--trace-output', () => {
    it('is no longer an accepted flag', () => {
      const { err, io: streams } = io();
      const cwd = dir();
      const code = runCli(['optimize', input(cwd), '--trace-output', 'stderr'], streams, cwd);

      expect(code).toBe(1);
      expect(err.join('')).toContain('--trace-output');
    });

    it('is absent from every command in the flag table', () => {
      for (const command of ['optimize', 'bench', 'mcp'] as const) {
        expect(SUPPORTED_FLAGS[command].has('--trace-output')).toBe(false);
      }
    });

    it('leaves an existing config file that still sets traceOutput loadable', () => {
      // Withdrawing a key must not turn a file that loaded yesterday into a hard error. The key
      // is no longer read or validated; an unrecognised key is ignored, as it always was.
      const cwd = dir();
      const configPath = join(cwd, 'tokendamper.config.json');
      writeFileSync(configPath, JSON.stringify({ traceOutput: 'stdout' }), 'utf8');

      expect(() => loadConfig({ cwd, configPath })).not.toThrow();
    });
  });

  describe('--mode explain', () => {
    it('rejects explain', () => {
      const { err, io: streams } = io();
      const cwd = dir();
      const code = runCli(['optimize', input(cwd), '--mode', 'explain'], streams, cwd);

      expect(code).toBe(1);
      expect(err.join('')).toContain('--mode');
    });

    // Until 2.0.0 these two were hard errors, the direction v1.6.0 set for the `TOKENDAMPER_*`
    // enums. 2.0.0 withdrew the setting itself (DECISIONS §87): any value now loads, with a notice
    // naming the replacement, because nothing reads it and failing a startup over it would turn a
    // configuration that worked yesterday into an error. `config-engine-mode.test.ts` pins the
    // notice.
    it('loads TOKENDAMPER_APP_MODE=explain with a notice rather than an error (2.0.0)', () => {
      const config = loadConfig({ cwd: dir(), env: { TOKENDAMPER_APP_MODE: 'explain' } });
      expect(config.notices.join('\n')).toContain('TOKENDAMPER_APP_MODE was withdrawn in 2.0.0');
    });

    it('loads app.mode: explain in a config file with a notice (2.0.0)', () => {
      const cwd = dir();
      const configPath = join(cwd, 'tokendamper.config.json');
      writeFileSync(configPath, JSON.stringify({ app: { mode: 'explain' } }), 'utf8');

      expect(loadConfig({ cwd, configPath }).notices.join('\n')).toContain('app.mode was withdrawn in 2.0.0');
    });
  });

  describe('what is deliberately kept', () => {
    it('keeps TOKENDAMPER_APP_MODE=bench and =optimize', () => {
      for (const mode of ['optimize', 'bench']) {
        expect(() => loadConfig({ cwd: dir(), env: { TOKENDAMPER_APP_MODE: mode } })).not.toThrow();
      }
    });
  });
});

describe('--engine-mode and the old --mode values (2.0.0)', () => {
  it('are absent from every command in the flag table', () => {
    for (const command of ['optimize', 'bench', 'mcp'] as const) {
      expect(SUPPORTED_FLAGS[command].has('--engine-mode')).toBe(false);
    }
    expect(SUPPORTED_FLAGS.optimize.has('--mode')).toBe(true);
    expect(SUPPORTED_FLAGS.bench.has('--mode')).toBe(false);
    expect(SUPPORTED_FLAGS.mcp.has('--mode')).toBe(false);
  });
});

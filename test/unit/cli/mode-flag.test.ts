import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli } from '../../../src/cli/main';

function io() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let err = '';
  stdout.resume();
  stderr.on('data', (c) => (err += String(c)));
  return {
    stdout,
    stderr,
    get err() {
      return err;
    },
  };
}

/**
 * 2.0.0 frees `--mode` for the engine (DECISIONS §87). It used to take `optimize|bench`, where
 * `optimize` was the identity and `bench` duplicated the positional command, and the engine had
 * its own `--engine-mode`. Each withdrawn spelling is a parse error naming its replacement — never
 * a silent reinterpretation, because a script passing `--mode bench` must not start optimizing.
 */
describe('--mode is the engine at 2.0 (DECISIONS §87)', () => {
  it('accepts fast, which is the default', () => {
    expect(runCli(['optimize', 'README.md', '--mode', 'fast'], io())).toBe(0);
  });

  it('rejects a value that is neither fast nor deep', () => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--mode', 'turbo'], s)).toBe(1);
    expect(s.err).toContain('Accepted values: fast, deep');
  });

  it.each(['optimize', 'bench'])('names the positional command for the withdrawn --mode %s', (value) => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--mode', value], s)).toBe(1);
    expect(s.err).toContain(`--mode ${value} was withdrawn in 2.0.0`);
    expect(s.err).toContain(`tokendamper ${value}`);
  });

  it('names --mode for the withdrawn --engine-mode', () => {
    const s = io();
    expect(runCli(['optimize', 'README.md', '--engine-mode', 'deep'], s)).toBe(1);
    expect(s.err).toContain('--engine-mode was withdrawn in 2.0.0; use --mode fast|deep');
  });

  // `bench`'s runner reads no engine mode and the MCP server registers no backends, so accepting
  // `--mode deep` on either would report a deep run that never happened (invariant 10). Refused
  // the way every misplaced flag is: `rejectUnsupportedFlags` names the command it applies to.
  it.each(['bench', 'mcp'])('is refused on %s, naming where it applies', (command) => {
    const s = io();
    expect(runCli([command, '--mode', 'deep'], s)).toBe(1);
    expect(s.err).toContain('applies to: optimize');
  });
});

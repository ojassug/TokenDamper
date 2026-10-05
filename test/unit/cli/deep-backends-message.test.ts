import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read from source rather than triggered: provoking the load failure means hiding a package the
 * suite's own deep tests need. What has to stay true is what a user is told to do (2.0.0).
 */
describe('the deep discovery error names the install (2.0.0)', () => {
  const src = readFileSync(join(__dirname, '..', '..', '..', 'src', 'cli', 'deep-backends.ts'), 'utf8');

  it('tells a user to install the package, not that it is unpublished', () => {
    expect(src).toContain('npm install tokendamper-deep');
    expect(src).not.toContain('unpublished in R3');
    expect(src).toContain('--mode deep');
  });
});

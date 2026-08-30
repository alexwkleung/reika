import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, outlineInstructions } from './bootstrap.js';

describe('outlineInstructions', () => {
  it('collapses the file to its headings plus a read pointer', () => {
    const content = [
      '# Project',
      'Long intro prose that should not survive.',
      '## Build',
      'npm run build',
      '### Caveats',
      'more prose',
      '#### Too deep to keep',
    ].join('\n');
    const out = outlineInstructions(content, 'AGENTS.md');
    expect(out).toContain('# Project');
    expect(out).toContain('## Build');
    expect(out).toContain('### Caveats');
    expect(out).not.toContain('#### Too deep to keep');
    expect(out).not.toContain('Long intro prose');
    expect(out).toContain(`too large to include in full (${content.length} chars)`);
    expect(out).toContain('Read the relevant section of AGENTS.md');
  });

  it('ignores heading-looking lines inside code fences', () => {
    const content = ['# Real', '```bash', '# just a comment', '```', '## Also real'].join('\n');
    const out = outlineInstructions(content, 'AGENTS.md');
    expect(out).toContain('# Real');
    expect(out).toContain('## Also real');
    expect(out).not.toContain('# just a comment');
  });

  it('falls back to the head of the file when there are no headings', () => {
    const content = 'plain prose with no headings\n'.repeat(600);
    const out = outlineInstructions(content, 'CLAUDE.md');
    expect(out).toContain('Beginning of file:');
    expect(out).toContain('plain prose with no headings');
    expect(out.length).toBeLessThan(content.length);
    expect(out).toContain('Read the relevant section of CLAUDE.md');
  });
});

// The bundle-size line (#194) is emitted from bootstrap rather than from App's startup effect
// so that a /cd re-index — which goes through bootstrap too — reports its new bundle as well.
describe('bootstrap bundle-size reporting', () => {
  let dir: string;
  let logDir: string;
  let log: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reika-bundlesize-'));
    // The log lives outside the indexed dir: a file inside it would land in projectSummary
    // and change the bundle between the two runs.
    logDir = mkdtempSync(join(tmpdir(), 'reika-bundlelog-'));
    log = join(logDir, 'debug.log');
    process.env.REIKA_DEBUG = '1';
    process.env.REIKA_DEBUG_FILE = log;
  });

  afterEach(() => {
    delete process.env.REIKA_DEBUG;
    delete process.env.REIKA_DEBUG_FILE;
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it('reports the bundle every time it is built', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Guide\nBe concise.\n');
    const bundle = await bootstrap(dir);
    await bootstrap(dir);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toContain(`bundle hash=${bundle.hash}`);
      expect(line).toContain(`instructions=${bundle.instructions.length}c`);
    }
  });

  it('writes nothing when REIKA_DEBUG is unset', async () => {
    delete process.env.REIKA_DEBUG;
    await bootstrap(dir);
    expect(() => readFileSync(log, 'utf8')).toThrow();
  });
});

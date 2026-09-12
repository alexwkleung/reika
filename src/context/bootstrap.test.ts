import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, loadInstructions, outlineInstructions } from './bootstrap.js';

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

// #29: a global ~/.config/reika/AGENTS.md merges with the project's rather than one
// displacing the other. The global dir is injected so the tests never touch the real home.
describe('loadInstructions', () => {
  let cwd: string;
  let globalDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'reika-instr-cwd-'));
    globalDir = mkdtempSync(join(tmpdir(), 'reika-instr-global-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('passes a lone project file through verbatim', async () => {
    writeFileSync(join(cwd, 'AGENTS.md'), '# Project\nUse tabs.\n');
    expect(await loadInstructions(cwd, globalDir)).toBe('# Project\nUse tabs.\n');
  });

  it('passes a lone global file through verbatim', async () => {
    writeFileSync(join(globalDir, 'AGENTS.md'), '# Me\nTerse replies.\n');
    expect(await loadInstructions(cwd, globalDir)).toBe('# Me\nTerse replies.\n');
  });

  it('returns an empty string when neither exists', async () => {
    expect(await loadInstructions(cwd, globalDir)).toBe('');
  });

  it('merges both, global first, with the precedence rule stated', async () => {
    writeFileSync(join(globalDir, 'AGENTS.md'), 'GLOBAL-BODY');
    writeFileSync(join(cwd, 'AGENTS.md'), 'PROJECT-BODY');
    const out = await loadInstructions(cwd, globalDir);
    expect(out).toContain('Global (personal) instructions ---\nGLOBAL-BODY');
    expect(out).toContain('Project instructions ---\nPROJECT-BODY');
    expect(out.indexOf('GLOBAL-BODY')).toBeLessThan(out.indexOf('PROJECT-BODY'));
    expect(out).toContain('the project file wins');
  });

  it('accepts CLAUDE.md as the fallback name in either location', async () => {
    writeFileSync(join(globalDir, 'CLAUDE.md'), 'GLOBAL-CLAUDE');
    writeFileSync(join(cwd, 'CLAUDE.md'), 'PROJECT-CLAUDE');
    const out = await loadInstructions(cwd, globalDir);
    expect(out).toContain('GLOBAL-CLAUDE');
    expect(out).toContain('PROJECT-CLAUDE');
  });

  it('applies the size budget per file and points the global outline at its ~ path', async () => {
    const big = '# Prefs\n' + 'x'.repeat(13 * 1024) + '\n## More\n';
    writeFileSync(join(globalDir, 'AGENTS.md'), big);
    writeFileSync(join(cwd, 'AGENTS.md'), 'PROJECT-BODY');
    const out = await loadInstructions(cwd, globalDir);
    expect(out).toContain('~/.config/reika/AGENTS.md is too large to include in full');
    expect(out).toContain('Read the relevant section of ~/.config/reika/AGENTS.md');
    expect(out).not.toContain('x'.repeat(100));
    // The small project file is untouched by the global file's size.
    expect(out).toContain('Project instructions ---\nPROJECT-BODY');
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

    // Since 188bb03 each session also writes a `flags` line beside the bundle line, so select the
    // bundle lines rather than counting everything in the log — the claim is "one per build", not
    // "the log has N lines", and the next debug line added shouldn't break this test again.
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    const bundleLines = lines.filter(l => l.includes('bundle hash='));
    expect(bundleLines).toHaveLength(2);
    for (const line of bundleLines) {
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

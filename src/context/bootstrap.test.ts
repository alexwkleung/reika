import { describe, expect, it } from 'vitest';
import { outlineInstructions } from './bootstrap.js';

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

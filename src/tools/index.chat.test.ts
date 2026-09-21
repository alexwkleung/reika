import { describe, expect, it } from 'vitest';
import { chatTools, defaultTools, planTools } from './index.js';

// fetch_url keys "can the model follow a spill locator" off the presence of `read` in the turn's
// tool list (#377). That is only sound while the lists keep this shape: chat has none of the
// tools a locator names, and every other mode has `read`. Stated as a test rather than a comment
// so a tool added to chat mode, or `read` dropped from another, is a failing build and not a
// footer that quietly lies again.
describe('tool lists — locator coupling (#377)', () => {
  it('chat mode has no tool that could open a spill file', () => {
    const names = chatTools().map(t => t.name);
    expect(names).toContain('fetch_url');
    for (const opener of ['read', 'grep', 'bash', 'glob', 'list']) {
      expect(names).not.toContain(opener);
    }
  });

  it('every mode that can open a spill file has `read`', () => {
    expect(defaultTools().map(t => t.name)).toContain('read');
    expect(planTools().map(t => t.name)).toContain('read');
  });
});

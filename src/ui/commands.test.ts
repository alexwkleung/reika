import { describe, expect, it } from 'vitest';
import { COMMANDS, buildImplementPrompt, planWritten } from './commands.js';
import type { Message } from '../types.js';

describe('COMMANDS — /implement', () => {
  it('is registered so it autocompletes and shows in suggestions', () => {
    const implement = COMMANDS.find(c => c.name === 'implement');
    expect(implement).toBeDefined();
    expect(implement?.desc).toMatch(/agent mode/i);
  });
});

describe('COMMANDS — /vibe', () => {
  it('is registered so it autocompletes and shows in suggestions', () => {
    const vibe = COMMANDS.find(c => c.name === 'vibe');
    expect(vibe).toBeDefined();
    expect(vibe?.desc).toMatch(/plan/i);
  });
});

describe('planWritten', () => {
  it('finds the planFinal marker on an assistant message', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'add a flag' },
      { role: 'assistant', content: '1. Edit src/config.ts …', planFinal: true },
    ];
    expect(planWritten(msgs)).toBe(true);
  });

  it('is false for a turn with no finalized plan (e.g. aborted mid-exploration)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'add a flag' },
      { role: 'assistant', content: '(aborted)' },
    ];
    expect(planWritten(msgs)).toBe(false);
  });

  it('ignores plan-looking text that lacks the marker — the signal is the harness stamp, not content', () => {
    const msgs: Message[] = [{ role: 'assistant', content: '1. Edit src/config.ts\n2. Run tests' }];
    expect(planWritten(msgs)).toBe(false);
  });
});

describe('buildImplementPrompt', () => {
  it('points the model at the plan already in history', () => {
    const prompt = buildImplementPrompt('');
    // "the plan above" is load-bearing: the plan sits verbatim in history (handoff distillation),
    // so the prompt only references it rather than restating intent.
    expect(prompt).toContain('plan above');
    expect(prompt).toContain('step by step');
  });

  it('omits the guidance section when there are no args', () => {
    expect(buildImplementPrompt('')).not.toContain('Additional guidance');
  });

  it('treats whitespace-only args as no args', () => {
    expect(buildImplementPrompt('   ')).toBe(buildImplementPrompt(''));
  });

  it('appends trailing args as explicit additional guidance', () => {
    const prompt = buildImplementPrompt('focus on the error paths first');
    expect(prompt).toContain('Additional guidance: focus on the error paths first');
    // The base instruction is preserved ahead of the guidance.
    expect(prompt.indexOf('plan above')).toBeLessThan(prompt.indexOf('Additional guidance'));
  });

  it('trims surrounding whitespace from the guidance', () => {
    expect(buildImplementPrompt('  do X  ')).toContain('Additional guidance: do X');
  });
});

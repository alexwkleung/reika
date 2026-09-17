import { describe, expect, it } from 'vitest';
import { buildHeadlessInput, finalReply } from './headless.js';
import { parseHeadlessArgs } from './headlessargs.js';
import type { Config, ContextBundle, Message } from './types.js';

describe('parseHeadlessArgs', () => {
  it('returns null with no headless flag, so the TUI starts', () => {
    expect(parseHeadlessArgs([])).toBeNull();
  });

  it('takes the prompt after -p or --prompt', () => {
    expect(parseHeadlessArgs(['-p', 'fix the bug'])?.prompt).toBe('fix the bug');
    expect(parseHeadlessArgs(['--prompt', 'fix the bug'])?.prompt).toBe('fix the bug');
  });

  it('leaves the prompt absent for a bare -p so stdin is read', () => {
    const args = parseHeadlessArgs(['-p']);
    expect(args).not.toBeNull();
    expect(args?.prompt).toBeUndefined();
  });

  it('accepts the prompt as a positional after other flags', () => {
    const args = parseHeadlessArgs(['-p', '--json', 'hello']);
    expect(args?.prompt).toBe('hello');
    expect(args?.json).toBe(true);
  });

  it('parses mode, json and save', () => {
    const args = parseHeadlessArgs(['-p', 'x', '--mode', 'plan', '--json', '--save']);
    expect(args).toMatchObject({ prompt: 'x', mode: 'plan', json: true, save: true });
  });

  it('rejects an unknown mode', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--mode', 'shell'])).toThrow(/--mode/);
  });

  it('rejects an unknown flag rather than running the wrong turn', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--yolo'])).toThrow(/unknown flag --yolo/);
  });

  it('rejects a stray positional', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', 'y'])).toThrow(/unexpected argument y/);
    expect(() => parseHeadlessArgs(['x'])).toThrow(/unexpected argument x/);
  });

  it('--help is headless on its own', () => {
    expect(parseHeadlessArgs(['--help'])?.help).toBe(true);
  });
});

describe('finalReply', () => {
  it('is the last assistant message with content', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'first' },
      { role: 'tool', callId: '1', summary: 'out' },
      { role: 'assistant', content: 'final' },
    ];
    expect(finalReply(msgs)).toBe('final');
  });

  it('is null when no assistant message has content', () => {
    expect(finalReply([{ role: 'user', content: 'q' }])).toBeNull();
    expect(finalReply([{ role: 'assistant', content: '  ' }])).toBeNull();
  });
});

const config = {
  pasteFetch: false,
  skillAuto: true,
  contextWindow: 24000,
} as unknown as Config;

function bundleWith(skills: ContextBundle['skills']): ContextBundle {
  return { cwd: process.cwd(), skills } as unknown as ContextBundle;
}

const verify = {
  name: 'verify',
  description: 'verify a change',
  body: 'VERIFY BODY',
  source: 'project' as const,
  path: '/skills/verify.md',
  triggers: ['verify the change'],
};

describe('buildHeadlessInput', () => {
  it('runs a /<skill> prompt as that skill with the rest as guidance', async () => {
    const out = await buildHeadlessInput(
      '/verify the input box',
      config,
      bundleWith([verify]),
      'agent',
    );
    expect(out.modelText).toBe('VERIFY BODY\n\nthe input box');
    expect(out.skill).toBe('verify');
  });

  it('rejects an unknown /<skill>', async () => {
    await expect(buildHeadlessInput('/nope', config, bundleWith([]), 'agent')).rejects.toThrow(
      /unknown skill \/nope/,
    );
  });

  it('auto-injects a triggered skill in agent mode', async () => {
    const out = await buildHeadlessInput(
      'please verify the change',
      config,
      bundleWith([verify]),
      'agent',
    );
    expect(out.modelText.startsWith('VERIFY BODY\n\n')).toBe(true);
    expect(out.skill).toBe('verify');
    expect(out.notices[0]).toMatch(/Applied skill \/verify/);
  });

  it('never injects in plan mode', async () => {
    const out = await buildHeadlessInput(
      'please verify the change',
      config,
      bundleWith([verify]),
      'plan',
    );
    expect(out.modelText).toBe('please verify the change');
    expect(out.skill).toBeUndefined();
  });

  it('passes a plain prompt through untouched', async () => {
    const out = await buildHeadlessInput('what does this do', config, bundleWith([]), 'agent');
    expect(out).toEqual({ modelText: 'what does this do', notices: [] });
  });
});

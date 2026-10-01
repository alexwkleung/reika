import { describe, expect, it } from 'vitest';
import { buildHeadlessInput, createStreamPrinter, finalReply } from './headless.js';
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

  it('parses --stream, off by default', () => {
    expect(parseHeadlessArgs(['-p', 'x'])?.stream).toBe(false);
    expect(parseHeadlessArgs(['-p', '--stream', 'x'])).toMatchObject({ prompt: 'x', stream: true });
  });

  it('rejects an unknown mode', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--mode', 'shell'])).toThrow(/--mode/);
  });

  it('rejects an unknown flag rather than running the wrong turn', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--yolo'])).toThrow(/unknown flag --yolo/);
  });

  it('rejects a stray positional', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', 'y'])).toThrow(/unexpected argument y/);
  });

  it('points a -p-less prompt at pnpm -p, and at the npm -- npm eats itself', () => {
    expect(() => parseHeadlessArgs(['hi'])).toThrow(/pnpm run dev -p/);
    expect(() => parseHeadlessArgs(['hi'])).toThrow(/npm run dev -- -p/);
  });

  it('--help is headless on its own', () => {
    expect(parseHeadlessArgs(['--help'])?.help).toBe(true);
    expect(parseHeadlessArgs(['-h'])?.help).toBe(true);
  });

  it('--version is headless on its own', () => {
    expect(parseHeadlessArgs(['--version'])?.version).toBe(true);
    expect(parseHeadlessArgs(['-v'])?.version).toBe(true);
  });

  it('a prompt mentioning --version is still a prompt', () => {
    const args = parseHeadlessArgs(['-p', 'add a --version flag']);
    expect(args?.prompt).toBe('add a --version flag');
    expect(args?.version).toBe(false);
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
  pasteFetch: 'off',
  skillAuto: 'apply',
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
    expect(out.notices[0]).toMatch(
      /Skill \/verify applied — its body was sent as this prompt, with/,
    );
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
    expect(out.notices[0]).toMatch(/Skill \/verify applied — its body was prepended/);
  });

  it("sends the prompt as typed under the interactive default 'ask' — nobody to ask", async () => {
    const out = await buildHeadlessInput(
      'please verify the change',
      { ...config, skillAuto: 'ask' } as Config,
      bundleWith([verify]),
      'agent',
    );
    expect(out.modelText).toBe('please verify the change');
    expect(out.skill).toBeUndefined();
    expect(out.notices).toEqual([]);
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

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('createStreamPrinter', () => {
  it('writes the content channel as it arrives and tool summaries to stderr', () => {
    const c = capture();
    const p = createStreamPrinter(c.io, false);
    p.events.onPhase?.('thinking');
    p.events.onContentDelta?.('\n\nLet me ');
    expect(c.stdout()).toBe('Let me ');
    p.events.onContentDelta?.('look.');
    p.onMessage({ role: 'assistant', content: 'Let me look.' });
    p.events.onPhase?.('tool');
    p.onMessage({ role: 'tool', callId: '1', summary: 'Read src/a.ts\n(40 lines)' });
    p.events.onPhase?.('thinking');
    p.events.onContentDelta?.('Done.');
    p.onMessage({ role: 'assistant', content: 'Done.' });
    p.finish();
    expect(c.stdout()).toBe('Let me look.\n\nDone.\n');
    expect(c.stderr()).toBe('reika: ↳ Read src/a.ts\n');
  });

  it("keeps a subagent's rounds and the compaction note off stdout", () => {
    const c = capture();
    const p = createStreamPrinter(c.io, false);
    p.events.onSubagent?.(true);
    p.events.onContentDelta?.('nested report');
    p.onMessage({ role: 'tool', callId: 'n', summary: 'Read nested.ts', nested: true });
    p.events.onSubagent?.(false);
    p.onMessage({ role: 'tool', callId: '1', summary: 'Subagent completed' });
    p.events.onCompactionNote?.(true);
    p.events.onContentDelta?.('findings note');
    p.events.onCompactionNote?.(false);
    p.events.onContentDelta?.('answer');
    p.finish();
    expect(c.stdout()).toBe('answer\n');
    expect(c.stderr()).toBe('reika: ↳ Subagent completed\n');
  });

  it('adds no newline when the reply already ended on one', () => {
    const c = capture();
    const p = createStreamPrinter(c.io, false);
    p.events.onContentDelta?.('line\n');
    p.finish();
    expect(c.stdout()).toBe('line\n');
  });

  it('with json, prints each committed message as one NDJSON line and no deltas', () => {
    const c = capture();
    const p = createStreamPrinter(c.io, true);
    expect(p.events.onContentDelta).toBeUndefined();
    const msgs: Message[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ];
    for (const m of msgs) p.onMessage(m);
    p.finish();
    expect(
      c
        .stdout()
        .trimEnd()
        .split('\n')
        .map(l => JSON.parse(l)),
    ).toEqual(msgs);
  });
});

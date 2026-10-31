import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildHeadlessInput,
  createHeadlessAutosave,
  createHeadlessStatus,
  createStreamPrinter,
  finalReply,
  formatTurnFailure,
  headlessProfile,
} from './headless.js';
import { parseHeadlessArgs } from './headlessargs.js';
import { listSessions, loadSession } from '../store/sessions.js';
import { TRANSCRIPT_VERSION, type TranscriptMeta } from '../store/transcript.js';
import type { Config, ContextBundle, Message } from '../types.js';

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

  it('parses -i / --interactive, off by default, and only with -p', () => {
    expect(parseHeadlessArgs(['-p', 'x'])?.interactive).toBe(false);
    expect(parseHeadlessArgs(['-p', 'x', '-i'])?.interactive).toBe(true);
    expect(parseHeadlessArgs(['--interactive', '-p', 'x'])?.interactive).toBe(true);
    expect(() => parseHeadlessArgs(['--interactive'])).toThrow(/add -p/);
  });

  it('rejects an unknown mode', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--mode', 'shell'])).toThrow(/--mode/);
  });

  it('rejects an unknown flag rather than running the wrong turn', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--yolo'])).toThrow(/unknown flag --yolo/);
  });

  it('takes --profile with -p, in any position', () => {
    expect(parseHeadlessArgs(['-p', 'x', '--profile', 'kimi'])?.profile).toBe('kimi');
    expect(parseHeadlessArgs(['--profile', 'kimi', '-p', 'x'])).toMatchObject({
      prompt: 'x',
      profile: 'kimi',
    });
  });

  it('refuses a --profile with no name rather than swallowing the next flag', () => {
    expect(() => parseHeadlessArgs(['-p', 'x', '--profile'])).toThrow(/--profile needs/);
    expect(() => parseHeadlessArgs(['--profile', '-p', 'x'])).toThrow(/--profile needs/);
    expect(() => parseHeadlessArgs(['-p', 'x', '--profile', '--json'])).toThrow(/--profile needs/);
  });

  it('refuses --profile without -p, since the TUI would drop it silently', () => {
    expect(() => parseHeadlessArgs(['--profile', 'kimi'])).toThrow(/add -p/);
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

  it('asks before applying a matched skill with --interactive, in plan mode too', async () => {
    const asked: string[] = [];
    const out = await buildHeadlessInput(
      'please verify the change',
      { ...config, skillAuto: 'ask' } as Config,
      bundleWith([verify]),
      'plan',
      async spec => (asked.push(spec.title), true),
    );
    expect(asked).toEqual(['Skill']);
    expect(out.modelText.startsWith('VERIFY BODY\n\n')).toBe(true);
    expect(out.skill).toBe('verify');
  });

  it('sends as typed when the interactive confirm is declined, even under apply', async () => {
    const out = await buildHeadlessInput(
      'please verify the change',
      config,
      bundleWith([verify]),
      'agent',
      async () => false,
    );
    expect(out.modelText).toBe('please verify the change');
    expect(out.skill).toBeUndefined();
  });

  it('asks about an incidental pasted link and leaves it on a decline, with no receipt', async () => {
    const asked: string[][] = [];
    const out = await buildHeadlessInput(
      'the build failed:\nError: see https://example.com/x for details',
      { ...config, pasteFetch: 'ask' } as Config,
      bundleWith([]),
      'agent',
      async spec => (asked.push(spec.details), false),
    );
    expect(asked).toEqual([['https://example.com/x']]);
    expect(out.notices).toEqual([]);
  });

  it('asks nothing for a plain prompt with --interactive', async () => {
    let calls = 0;
    await buildHeadlessInput('what does this do', config, bundleWith([]), 'agent', async () => {
      calls++;
      return true;
    });
    expect(calls).toBe(0);
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

describe('headlessProfile (#710)', () => {
  const profile = { model: 'm', baseURL: 'http://localhost:8080/v1', apiKey: 'k' };
  const config = {
    profiles: { default: profile, kimi: { ...profile, model: 'kimi-k2' } },
  } as unknown as Config;

  it('uses the named profile, matched case-insensitively', () => {
    expect(headlessProfile(config, 'agent', 'kimi')).toEqual({ profile: 'kimi' });
    expect(headlessProfile(config, 'agent', 'Kimi')).toEqual({ profile: 'kimi' });
  });

  it("outranks the mode's own model", () => {
    const mapped = { ...config, modeProfiles: { plan: 'kimi' } } as unknown as Config;
    expect(headlessProfile(mapped, 'plan', 'default')).toEqual({ profile: 'default' });
  });

  it('falls back to a defined profile on an unknown name, and says so', () => {
    const chosen = headlessProfile(config, 'agent', 'typo');
    expect(chosen.profile).toBe('default');
    expect(chosen.notice).toMatch(
      /no profile named "typo" \(defined: default, kimi\); using "default"/,
    );
  });

  it('is the ordinary start profile without the flag', () => {
    expect(headlessProfile(config, 'agent')).toEqual({ profile: 'default' });
  });
});

describe('formatTurnFailure', () => {
  it('names the route without calling every failure a fetch failure', () => {
    expect(
      formatTurnFailure('kimi', 'https://api.example.com/v1', 'This operation was aborted'),
    ).toBe(
      'reika: turn failed (profile "kimi" at https://api.example.com/v1): This operation was aborted',
    );
  });
});

describe('createHeadlessAutosave', () => {
  const meta = (midTurn: boolean): TranscriptMeta => ({
    version: TRANSCRIPT_VERSION,
    savedAt: new Date().toISOString(),
    model: 'm',
    baseURL: 'http://localhost:1/v1',
    cwd: '/repo',
    messageCount: 0,
    mode: 'agent',
    ...(midTurn ? { midTurn: true as const } : {}),
  });

  const withDir = async (run: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'reika-headless-autosave-'));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it('writes the session where /resume lists it, and the final save is not mid-turn', () =>
    withDir(async dir => {
      const path = join(dir, 'projects', 'repo-1', 's.jsonl');
      const msgs: Message[] = [{ role: 'user', content: 'fix the bug' }];
      const saver = createHeadlessAutosave(
        path,
        () => msgs,
        'agent',
        meta,
        () => {},
        60_000,
      );
      saver.onMessage();
      msgs.push({ role: 'assistant', content: 'done' });
      saver.onMessage();
      await saver.finish();
      expect((await loadSession(path)).agent.map(m => ('content' in m ? m.content : null))).toEqual(
        ['fix the bug', 'done'],
      );
      const [entry] = await listSessions(join(dir, 'projects', 'repo-1'));
      expect(entry?.title).toBe('fix the bug');
      const header = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!) as TranscriptMeta;
      expect(header.midTurn).toBeUndefined();
    }));

  it('files a chat run on the chat side, so a resume keeps it out of agent history', () =>
    withDir(async dir => {
      const path = join(dir, 's.jsonl');
      const msgs: Message[] = [
        { role: 'user', content: 'what is a monad' },
        { role: 'assistant', content: 'a monoid in…' },
      ];
      const saver = createHeadlessAutosave(
        path,
        () => msgs,
        'chat',
        meta,
        () => {},
        60_000,
      );
      saver.onMessage();
      await saver.finish();
      const sides = await loadSession(path);
      expect(sides.agent).toEqual([]);
      expect(sides.chat).toHaveLength(2);
      const [entry] = await listSessions(dir);
      expect(entry?.title).toBe('what is a monad');
    }));

  it('writes nothing for a run with no real prompt', () =>
    withDir(async dir => {
      const path = join(dir, 's.jsonl');
      const msgs: Message[] = [{ role: 'user', content: '/srv:tool', meta: true }];
      const saver = createHeadlessAutosave(
        path,
        () => msgs,
        'agent',
        meta,
        () => {},
        60_000,
      );
      saver.onMessage();
      await saver.finish();
      await expect(stat(path)).rejects.toThrow();
    }));

  it('reports a failed write once', () =>
    withDir(async dir => {
      // A path whose parent is a file cannot be created.
      const blocker = join(dir, 'file');
      await writeFile(blocker, 'x');
      const errors: string[] = [];
      const msgs: Message[] = [{ role: 'user', content: 'hi' }];
      const saver = createHeadlessAutosave(
        join(blocker, 's.jsonl'),
        () => msgs,
        'agent',
        meta,
        e => errors.push(e),
        60_000,
      );
      saver.onMessage();
      await saver.finish();
      expect(errors).toHaveLength(1);
    }));
});

describe('createHeadlessStatus', () => {
  const session = {
    config: { contextWindow: 8000, minGenTokens: 1024 },
    totals: { promptTokens: 10, completionTokens: 2 },
    shrink: { sheds: 0, folds: 1 },
  };

  it('tracks the estimate and the last call as App does', () => {
    const t = createHeadlessStatus(() => []);
    t.events.onContextEstimate?.(42);
    expect(t.status(session)).toMatchObject({ estimatedContext: 42, lastUsage: null });
    t.events.onUsage?.({ promptTokens: 50, completionTokens: 3 });
    expect(t.status(session)).toMatchObject({
      lastUsage: { promptTokens: 50 },
      contextWindow: 8000,
      minGenTokens: 1024,
    });
  });

  it('stamps a shrink with the turn it landed in and drops the stale last call', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'reading' },
    ];
    const t = createHeadlessStatus(() => msgs);
    t.events.onUsage?.({ promptTokens: 50, completionTokens: 3 });
    t.events.onShrink?.(
      { kind: 'fold', round: 3, removed: 4, recapChars: 900 },
      { sheds: 0, folds: 1 },
    );
    expect(t.status(session)).toMatchObject({
      lastUsage: null,
      shrinkEvents: [{ kind: 'fold', turn: 2, round: 3 }],
    });
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message } from '../types.js';

// Drive the real runTurn loop with a scripted model to exercise the content-channel spin cut
// end to end (#944): a reply that repeats itself in its VISIBLE output is cut mid-stream, retried
// through the same recovery the token wall uses, and announced as repetition rather than as an
// ordinary truncation. The reasoning-channel cuts have their own files (loop.reasoningceil,
// loop.continuation); this one only ever streams `content`.

const h = vi.hoisted(() => ({
  scripted: [] as ModelResponse[],
  // Content to stream through onContentDelta for this call, in order. When an entry is present the
  // call "answers" with it — which is what a cut stream returns: callModel hands back the partial
  // content with no tool calls once the abort lands (provider/client.ts).
  stream: [] as string[],
}));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async (opts: { onContentDelta?: (t: string) => void }) => {
    const chunk = h.stream.shift();
    if (chunk !== undefined) {
      // Chunks larger than CONTENT_SPIN_DEBOUNCE (2000) so the gate actually runs.
      for (let i = 0; i < chunk.length; i += 1000) opts.onContentDelta?.(chunk.slice(i, i + 1000));
      return { content: chunk, toolCalls: undefined };
    }
    return h.scripted.shift() ?? { content: 'done', toolCalls: undefined };
  }),
}));

const PRIOR_DEBUG = process.env.REIKA_DEBUG;
const PRIOR_FILE = process.env.REIKA_DEBUG_FILE;
process.env.REIKA_DEBUG = '1';
afterAll(() => {
  for (const [k, v] of [
    ['REIKA_DEBUG', PRIOR_DEBUG],
    ['REIKA_DEBUG_FILE', PRIOR_FILE],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

// Case 1 from the issue (lfm2.5, 16k window): thinking leaked into the output channel, so the
// reasoning detectors never saw it. One paragraph re-emitted, past the gate's minimum length.
function loopingContent(n = 170): string {
  return Array.from(
    { length: n },
    () =>
      'let me re-read the task again and check the fetch failed branch: the sandbox is blocking ' +
      'repeated reads, so maybe the message comes from callMcpTool rather than the tool result',
  ).join('\n\n');
}

// Long output that repeats its SHAPE but not its words — the case a loose gate would cut.
function longTable(n = 420): string {
  const rows = ['| file | lines | tokens | bytes |', '| --- | --- | --- | --- |'];
  for (let i = 0; i < n; i++) {
    rows.push(`| src/module${i}.ts | ${i * 7 + 11} | ${i * 31 + 3} | ${i * 97 + 5} |`);
  }
  return rows.join('\n');
}

const LOOP_MARK = 'let me re-read the task again';

function makeBundle(cwd: string): ContextBundle {
  return {
    projectSummary: '',
    repoMap: '',
    instructions: '',
    cwd,
    hash: 'test',
    fileIndex: [],
    ignore: ignore(),
    skills: [],
  };
}

function makeConfig(): Config {
  return {
    baseURL: 'http://localhost',
    apiKey: 'x',
    model: 'test',
    models: ['test'],
    maxTurns: 10,
    repoMapBudget: 1000,
    autoApprove: 'bypass',
    subagentMaxTurns: 5,
    profiles: {},
    minGenTokens: 1024,
    reasoningRounds: 1,
    maxSearchesPerTurn: 0,
    maxFetchesPerTurn: 0,
    bashTimeoutMs: 5000,
    bashIdleMs: 5000,
    pasteFetch: 'off',
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

describe('content-channel spin cut (integration)', () => {
  let cwd: string;
  let dir: string;
  let logPath: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-ctspin-'));
    dir = await mkdtemp(join(tmpdir(), 'reika-ctspin-log-'));
    logPath = join(dir, 'debug.log');
    process.env.REIKA_DEBUG_FILE = logPath;
    h.scripted.length = 0;
    h.stream.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  async function run(): Promise<{ history: Message[]; messages: Message[]; log: string }> {
    const history: Message[] = [];
    const messages: Message[] = [];
    await runTurn({
      userInput: 'work through the problem',
      history,
      bundle: makeBundle(cwd),
      config: makeConfig(),
      tools: [],
      payloads: new PayloadStore(),
      promptMode: 'agent',
      onMessage: m => messages.push(m),
    });
    return { history, messages, log: await readFile(logPath, 'utf8').catch(() => '') };
  }

  it('cuts a looping content stream, retries, and names repetition rather than the token limit', async () => {
    h.stream.push(loopingContent(), 'the answer');
    const { history, messages } = await run();

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    // The notice has to say what happened: this cut lands tens of thousands of chars under the
    // token wall, and reading it as an ordinary truncation hides the loop.
    const notice = messages.find(m => m.role === 'system' && m.content.includes('repeating'));
    expect(notice?.role === 'system' && notice.content).toBe(
      'Output was repeating itself — stopped it and retrying.',
    );
    expect(messages.some(m => m.role === 'system' && m.content.includes('token limit'))).toBe(
      false,
    );

    // The discarded round is NOT fed back: re-feeding a repeat its own text is what makes it worse,
    // and unlike the token-wall retry there is no partial to resume from.
    expect(history.some(m => m.role === 'assistant' && (m.content ?? '').includes(LOOP_MARK))).toBe(
      false,
    );
    const nudge = history.find(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('repeating the same text over and over'),
    );
    expect(nudge).toBeDefined();
    // Not a turn boundary (#287), for the same reason the truncation nudge isn't: it fires on the
    // rounds where the task spec matters most.
    expect(nudge?.harness).toBe(true);
    // The retry's own answer lands normally.
    expect(history.some(m => m.role === 'assistant' && m.content === 'the answer')).toBe(true);
  });

  it('does not cut below the minimum length, however perfect the repeat', async () => {
    // ~14k of verbatim repetition: ratio ~1.0, under the judged length. The length gate is what
    // keeps a cheap repeat in a short reply from costing the user their answer.
    h.stream.push(loopingContent(80));
    const { messages } = await run();

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(1);
    expect(messages.some(m => m.role === 'system' && m.content.includes('repeating'))).toBe(false);
  });

  it('does not cut a long reply that repeats its shape but not its words', async () => {
    h.stream.push(longTable());
    const { messages, log } = await run();

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(1);
    expect(messages.some(m => m.role === 'system' && m.content.includes('repeating'))).toBe(false);
    // Still graded: the point of logging below the bar is that a near miss is visible in a real run
    // rather than only in this replay.
    const lines = log.split('\n').filter(l => l.includes('] content-spin round='));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every(l => l.includes('gate=measure'))).toBe(true);
  });

  it('logs the ratio, window, chars and fence state of every judged check', async () => {
    h.stream.push(loopingContent(), 'the answer');
    const { log } = await run();

    const lines = log.split('\n').filter(l => l.includes('] content-spin round='));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(
      /content-spin round=0 ratio=\d\.\d\d window=\d+ chars=\d+ fence=(yes|no) gate=(measure|cut)/,
    );
    // The firing check is marked as such, so a log can be graded into "measured" and "acted on"
    // without re-deriving the gate.
    expect(lines[lines.length - 1]).toContain('gate=cut');
    expect(lines[lines.length - 1]).toContain('chars=16000');
  });

  it('spends one recovery per turn, then lets a second loop run to the token wall', async () => {
    // A model that loops again after the retry is stuck. Cutting twice would pay two recoveries for
    // the same fault, so the second round commits instead and the length path owns it from there.
    h.stream.push(loopingContent(), loopingContent());
    const { messages } = await run();
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    const notices = messages.filter(m => m.role === 'system' && m.content.includes('repeating'));
    expect(notices.length <= 1).toBe(true);
  });
});

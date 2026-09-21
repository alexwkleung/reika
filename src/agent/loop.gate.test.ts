import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ignore from 'ignore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelResponse } from '../provider/client.js';
import { PayloadStore } from '../store/payloads.js';
import type { Config, ContextBundle, Message, Tool } from '../types.js';
import { editTool } from '../tools/edit.js';
import { writeTool } from '../tools/write.js';
import { bashTool } from '../tools/bash.js';

// Drive the real runTurn loop with a scripted model and a fake `tsc` so the post-edit typecheck
// gate's control flow (capture baseline → check at done → send back → re-check → finish / commit
// dirty / fail open) is exercised end to end, deterministically and offline.

const h = vi.hoisted(() => ({ scripted: [] as ModelResponse[] }));
vi.mock('../provider/client.js', () => ({
  callModel: vi.fn(async () => h.scripted.shift() ?? { content: 'done', toolCalls: undefined }),
}));

const { runTurn } = await import('./loop.js');
const { callModel } = await import('../provider/client.js');

const finalResponse = (content = 'done'): ModelResponse => ({ content, toolCalls: undefined });
const writeResponse = (path: string, content: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'w1', name: 'write', args: { path, content } }],
});
const editResponse = (path: string, oldStr: string, newStr: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'e1', name: 'edit', args: { path, old_string: oldStr, new_string: newStr } }],
});
const bashResponse = (command: string): ModelResponse => ({
  content: '',
  toolCalls: [{ id: 'b1', name: 'bash', args: { command } }],
});

// A fake tsc: emits a parseable diagnostic iff any file under src/ still contains the BREAKME
// sentinel, so an edit that writes it "breaks" the build and one that removes it "fixes" it. Ignores
// all the real flags (-p, --noEmit, …); the runner only cares about the binary's stdout.
const TSC_SHIM = `#!/bin/sh
if grep -rqI BREAKME "$PWD/src" 2>/dev/null; then
  printf 'src/app.ts(1,1): error TS2322: BREAKME sentinel present.\\n'
fi
exit 0
`;

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
    pasteFetch: false,
    skillAuto: 'off',
    anon: false,
    sandbox: false,
  };
}

async function run(
  cwd: string,
  tools: Tool[] = [editTool, writeTool],
): Promise<{ history: Message[]; messages: Message[] }> {
  const messages: Message[] = [];
  const history: Message[] = [];
  await runTurn({
    userInput: 'do the task',
    history,
    bundle: makeBundle(cwd),
    config: makeConfig(),
    tools,
    payloads: new PayloadStore(),
    onMessage: m => messages.push(m),
  });
  return { history, messages };
}

describe('post-edit typecheck gate (integration)', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'reika-gate-'));
    await writeFile(join(cwd, 'tsconfig.json'), '{}', 'utf8');
    h.scripted.length = 0;
    vi.mocked(callModel).mockClear();
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function installTsc() {
    const dir = join(cwd, 'node_modules', '.bin');
    await mkdir(dir, { recursive: true });
    const bin = join(dir, 'tsc');
    await writeFile(bin, TSC_SHIM, 'utf8');
    await chmod(bin, 0o755);
  }

  it('sends the model back to fix a type error its edit introduced, then finishes clean', async () => {
    await installTsc();
    h.scripted.push(
      // round 1: write a file containing the sentinel (introduces the error)
      writeResponse('src/app.ts', 'export const n = "BREAKME";\n'),
      // round 2: declare done — the gate should intercept and send it back
      finalResponse('all done'),
      // round 3: fix it by removing the sentinel
      editResponse('src/app.ts', '"BREAKME"', '0'),
      // round 4: declare done again — now clean, the gate lets it finish
      finalResponse('fixed and done'),
    );

    const { history, messages } = await run(cwd);

    // The gate consumed all four scripted rounds (it did not finish at round 2).
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    // The introduced error was carried back to the model as a user message.
    const sentBack = history.filter(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('BREAKME sentinel present'),
    );
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0].content).toContain('introduced 1 new type error');
    // Harness-authored, not a turn boundary: without the flag the task-spec pin re-elects to the
    // next tool result (#287).
    expect(sentBack[0].harness).toBe(true);
    // The user saw the send-back warning, then a clean-pass confirmation once fixed.
    expect(messages.some(m => m.role === 'system' && m.content.includes('sent back to fix'))).toBe(
      true,
    );
    expect(messages.some(m => m.role === 'system' && m.content.includes('Typecheck passed'))).toBe(
      true,
    );
    // The fix actually landed on disk.
    const onDisk = await readFile(join(cwd, 'src', 'app.ts'), 'utf8');
    expect(onDisk).not.toContain('BREAKME');
  });

  it('does not fire when the edit introduces no new errors', async () => {
    await installTsc();
    h.scripted.push(writeResponse('src/app.ts', 'export const n = 0;\n'), finalResponse('done'));

    const { history, messages } = await run(cwd);

    // Just the write round and the (clean) final round — no send-back.
    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    expect(history.some(m => m.role === 'user' && m.content.includes('BREAKME'))).toBe(false);
    // The clean check still leaves a visible, persistent confirmation line.
    expect(messages.some(m => m.role === 'system' && m.content.includes('Typecheck passed'))).toBe(
      true,
    );
  });

  it('gates an edit made through the shell, not just through the edit tools', async () => {
    // A heredoc is how a model with only bash writes a file. Before the gate keyed on `willMutate`
    // no baseline was captured for it, so the turn finished on code that no longer compiled.
    await installTsc();
    h.scripted.push(
      bashResponse('mkdir -p src && cat > src/app.ts <<\'EOF\'\nexport const n = "BREAKME";\nEOF'),
      finalResponse('all done'),
      bashResponse("sed -i '' 's/\"BREAKME\"/0/' src/app.ts"),
      finalResponse('fixed and done'),
    );

    const { history, messages } = await run(cwd, [bashTool]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(4);
    const sentBack = history.filter(
      (m): m is Extract<Message, { role: 'user' }> =>
        m.role === 'user' && m.content.includes('BREAKME sentinel present'),
    );
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0].harness).toBe(true);
    expect(messages.some(m => m.role === 'system' && m.content.includes('Typecheck passed'))).toBe(
      true,
    );
    const onDisk = await readFile(join(cwd, 'src', 'app.ts'), 'utf8');
    expect(onDisk).not.toContain('BREAKME');
  });

  it('leaves a read-only shell command alone', async () => {
    // The other half of the split: bash is inspection far more often than it is mutation, and a
    // `grep` must not put a tsc run in front of itself. Nothing ran, so nothing is reported.
    await installTsc();
    await mkdir(join(cwd, 'src'), { recursive: true });
    await writeFile(join(cwd, 'src', 'app.ts'), 'export const n = "BREAKME";\n', 'utf8');
    h.scripted.push(bashResponse('grep -rn BREAKME src'), finalResponse('found it'));

    const { messages } = await run(cwd, [bashTool]);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    expect(messages.some(m => m.role === 'system' && m.content.includes('Typecheck'))).toBe(false);
  });

  it('fails open and finishes when no checker is available', async () => {
    // No tsc shim installed: the baseline can't be captured, so the gate is disabled and a
    // sentinel-bearing edit finishes uninterrupted.
    h.scripted.push(
      writeResponse('src/app.ts', 'export const n = "BREAKME";\n'),
      finalResponse('done'),
    );

    const { history, messages } = await run(cwd);

    expect(vi.mocked(callModel)).toHaveBeenCalledTimes(2);
    expect(history.some(m => m.role === 'user' && m.content.includes('BREAKME'))).toBe(false);
    // Fail-open is silent: no send-back and no pass confirmation, since nothing actually ran.
    expect(messages.some(m => m.role === 'system' && m.content.includes('Typecheck'))).toBe(false);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runTurn } from '../src/agent/loop.js';
import { loadConfig } from '../src/config.js';
import { bootstrap } from '../src/context/bootstrap.js';
import { PayloadStore } from '../src/store/payloads.js';
import { defaultTools, planTools } from '../src/tools/index.js';
import type { Message } from '../src/types.js';

import type { AssertResult, Fixture } from './types.js';

import { fixture as f1 } from './fixtures/01-list.js';
import { fixture as f2 } from './fixtures/02-grep.js';
import { fixture as f3 } from './fixtures/03-read.js';
import { fixture as f4 } from './fixtures/04-edit.js';
import { fixture as f5 } from './fixtures/05-write.js';
import { fixture as f6 } from './fixtures/06-grep-spill-aggregable.js';
import { fixture as f7 } from './fixtures/07-glob-spill.js';
import { fixture as f8 } from './fixtures/08-grep-spill-noshell.js';
import { fixture as f9 } from './fixtures/09-bash-spill-verdict.js';
import { fixture as f10 } from './fixtures/10-bash-spill-oneshot.js';
import { fixture as f11 } from './fixtures/11-plan-gate-verdict.js';
import { fixture as f12 } from './fixtures/12-sandbox-recovery.js';

const FIXTURES: Fixture[] = [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

type RunRecord = {
  fixture: Fixture;
  result: AssertResult;
  elapsedMs: number;
  toolCallCount: number;
};

async function runFixture(fix: Fixture): Promise<RunRecord> {
  const cwd = await mkdtemp(join(tmpdir(), 'reika-eval-'));
  try {
    for (const [relPath, content] of Object.entries(fix.setup)) {
      const full = join(cwd, relPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }

    const config = loadConfig();
    const bundle = await bootstrap(cwd, config.repoMapBudget);
    const tools = fix.tools === 'plan' ? planTools() : defaultTools(config);
    const payloads = new PayloadStore();
    const messages: Message[] = [];

    const start = Date.now();
    const timeout = fix.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      await runTurn({
        userInput: fix.prompt,
        history: messages,
        bundle,
        config,
        tools,
        payloads,
        signal: controller.signal,
        // Without this every fixture ran as an agent turn regardless of its tool set, so plan-mode
        // behavior (the plan prompt, force-write, the `planFinal` stamp) was unreachable from an
        // eval — a fixture asserting on it passed vacuously.
        promptMode: fix.mode ?? 'agent',
        // history mutation already populates `messages`; pushing again here would
        // produce a duplicate of every message and break strict providers.
        onMessage: () => {},
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const elapsedMs = Date.now() - start;
    const timedOut = controller.signal.aborted;
    const toolCallCount = messages.reduce(
      (n, m) => (m.role === 'assistant' ? n + (m.toolCalls?.length ?? 0) : n),
      0,
    );

    if (timedOut) {
      return {
        fixture: fix,
        result: { pass: false, reason: 'timeout' },
        elapsedMs,
        toolCallCount,
      };
    }

    const result = await fix.assert({ cwd, messages, elapsedMs, toolCallCount });
    return { fixture: fix, result, elapsedMs, toolCallCount };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // `npm run eval -- spill` runs only matching fixtures. A local quantized model takes minutes
  // per fixture, so re-running one under test shouldn't cost the whole suite.
  const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const selected =
    filters.length > 0 ? FIXTURES.filter(f => filters.some(q => f.name.includes(q))) : FIXTURES;
  if (selected.length === 0) {
    process.stdout.write(`no fixture matches ${filters.join(', ')}\n`);
    process.exit(1);
  }

  const records: RunRecord[] = [];
  for (const fix of selected) {
    process.stdout.write(`  ${fix.name.padEnd(24)} … `);
    try {
      const rec = await runFixture(fix);
      records.push(rec);
      // Print the pass note, not just PASS: for the spill fixtures the interesting part of a
      // pass is *how* it got there (how many calls before it followed the locator), and that was
      // being thrown away.
      const status = rec.result.pass
        ? `PASS${rec.result.note ? ` — ${rec.result.note}` : ''}`
        : `FAIL — ${rec.result.reason}`;
      process.stdout.write(
        `${status} (${rec.toolCallCount} calls, ${(rec.elapsedMs / 1000).toFixed(1)}s)\n`,
      );
    } catch (e) {
      const reason = (e as Error).message;
      records.push({
        fixture: fix,
        result: { pass: false, reason },
        elapsedMs: 0,
        toolCallCount: 0,
      });
      process.stdout.write(`ERROR — ${reason}\n`);
    }
  }
  const passed = records.filter(r => r.result.pass).length;
  process.stdout.write(`\n${passed}/${records.length} passed\n`);
  process.exit(passed === records.length ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

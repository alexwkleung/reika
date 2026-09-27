import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { formatExperimentFlags } from '../src/debug.js';
import { createSession } from '../src/session.js';

import type { Message } from '../src/types.js';
import type { AssertResult, EvalMode, Fixture } from './types.js';

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
import { fixture as f14 } from './fixtures/14-self-docs.js';
import { fixture as f15 } from './fixtures/15-self-attractor.js';
import { fixture as f16 } from './fixtures/16-grind-chunk-guard.js';
import { fixture as f17 } from './fixtures/17-grind-chunk-hidden.js';

const FIXTURES: Fixture[] = [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f14, f15, f16, f17];
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// Web search auto-enables on a Mac with Chrome, which would put `search` in every fixture's prompt
// on some machines and not others. Pinned off before loadConfig's dotenv runs, so only a shell
// value (not a .env one) opts an eval run back in.
process.env.REIKA_CDP_SEARCH ??= '0';

// Every run's transcript and end state, outside the repo (a transcript holds whatever the model
// read, and these accumulate). The first grind runs failed a check in a way nobody could diagnose:
// the temp dir was gone and the messages were never written anywhere.
const RUNS_DIR = join(homedir(), '.config', 'reika', 'evals');

async function endState(fix: Fixture, cwd: string): Promise<Record<string, string>> {
  if (fix.gitInit) {
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    return {
      status: git('status', '--porcelain', '--untracked-files=all'),
      diff: git('diff'),
    };
  }
  const files: Record<string, string> = {};
  for (const relPath of Object.keys(fix.setup)) {
    files[relPath] = await readFile(join(cwd, relPath), 'utf8').catch(() => '(deleted)');
  }
  return files;
}

async function saveRun(run: {
  fix: Fixture;
  mode: EvalMode;
  model: string;
  result: AssertResult;
  elapsedMs: number;
  toolCallCount: number;
  messages: Message[];
  end: Record<string, string>;
}): Promise<string> {
  await mkdir(RUNS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(RUNS_DIR, `${stamp}-${run.fix.name}-${run.mode}.json`);
  const { fix, ...rest } = run;
  // The flags line, so an A/B arm set by env (REIKA_CALLER_CHECK=1) is readable off the file.
  const flags = formatExperimentFlags().replace(/^\[reika:debug\] flags /, '');
  await writeFile(
    path,
    JSON.stringify({ fixture: fix.name, prompt: fix.prompt, flags, ...rest }, null, 2),
  );
  return path;
}

type RunRecord = {
  fixture: Fixture;
  result: AssertResult;
  elapsedMs: number;
  toolCallCount: number;
  savedTo?: string;
};

async function runFixture(
  fix: Fixture,
  modeOverride?: EvalMode,
  profile?: string,
): Promise<RunRecord> {
  const cwd = await mkdtemp(join(tmpdir(), 'reika-eval-'));
  try {
    for (const [relPath, content] of Object.entries(fix.setup)) {
      const full = join(cwd, relPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, 'utf8');
    }
    if (fix.gitInit) {
      const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
      git('init', '-q');
      git('add', '-A');
      git(
        '-c',
        'user.name=octocat',
        '-c',
        'user.email=octocat@example.com',
        'commit',
        '-qm',
        'setup',
      );
    }

    // The TUI's boot, not a copy of it: a runner that booted on its own never probed the window,
    // so with REIKA_CONTEXT_WINDOW unset every fixture ran with no compaction, no prefix-stable and
    // no payload cap — a configuration no interactive session runs. No approver, as before: the
    // gate is skipped (bypass). No ask_user either: nobody answers it, and a model that sees it
    // calls it and stalls.
    const session = await createSession({ cwd, canAsk: false, profile });
    const messages = session.history;

    const start = Date.now();
    const timeout = fix.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Without `mode` every fixture ran as an agent turn regardless of its tool set, so plan-mode
      // behavior (the plan prompt, force-write, the `planFinal` stamp) was unreachable from an
      // eval — a fixture asserting on it passed vacuously. `tools` stays separate from it: a
      // fixture may run plan tools under the agent prompt (08-grep-spill-noshell).
      await session.submit(fix.prompt, {
        mode: modeOverride ?? fix.mode ?? 'agent',
        tools: fix.tools === 'plan' ? session.lists.plan : undefined,
        signal: controller.signal,
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

    const result: AssertResult = timedOut
      ? { pass: false, reason: 'timeout' }
      : await fix.assert({ cwd, messages, elapsedMs, toolCallCount });
    const savedTo = await saveRun({
      fix,
      mode: modeOverride ?? fix.mode ?? 'agent',
      model: session.config.profiles[profile ?? 'default']?.model ?? session.config.model,
      result,
      elapsedMs,
      toolCallCount,
      messages,
      end: await endState(fix, cwd),
    }).catch(() => undefined);
    return { fixture: fix, result, elapsedMs, toolCallCount, savedTo };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // `npm run eval -- spill` runs only matching fixtures. A local quantized model takes minutes
  // per fixture, so re-running one under test shouldn't cost the whole suite.
  const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const modeArg = process.argv.find(a => a.startsWith('--mode='))?.slice('--mode='.length);
  const MODES: EvalMode[] = ['agent', 'plan', 'minimal', 'grind'];
  if (modeArg !== undefined && !MODES.includes(modeArg as EvalMode)) {
    process.stdout.write(`unknown --mode=${modeArg} (expected ${MODES.join(' | ')})\n`);
    process.exit(1);
  }
  const modeOverride = modeArg as EvalMode | undefined;
  if (modeOverride) process.stdout.write(`  mode: ${modeOverride}\n`);
  // `--profile=go` runs against a named profile from the config, the way `/model go` would in the
  // TUI. The runner never reads the TUI's saved state, so without it every run uses `default`.
  const profile = process.argv
    .find(a => a.startsWith('--profile='))
    ?.slice('--profile='.length)
    .toLowerCase();
  if (profile) {
    const known = Object.keys(loadConfig().profiles);
    if (!known.includes(profile)) {
      process.stdout.write(`unknown --profile=${profile} (have ${known.join(', ')})\n`);
      process.exit(1);
    }
    process.stdout.write(`  profile: ${profile} (${loadConfig().profiles[profile].model})\n`);
  }
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
      const rec = await runFixture(fix, modeOverride, profile);
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
      if (rec.savedTo) process.stdout.write(`    transcript: ${rec.savedTo}\n`);
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

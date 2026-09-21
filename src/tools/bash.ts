import { spawn } from 'node:child_process';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { loadConfig } from '../config.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import { detectDangerousPatterns } from './_danger.js';
import {
  SANDBOX_EXEC_ERROR_PREFIX,
  SANDBOX_PROFILE_ERROR_CODE,
  broadWorkdirNotice,
  isBroadWorkdir,
  sandboxArgv,
  sandboxFooter,
  sandboxNotice,
  sandboxPlan,
} from './_sandbox.js';
import { recordCapped } from './_spillstats.js';
import { READ_ONLY_COMMAND_LIST, isProvablyReadOnly } from './_readonly.js';
import { changesSince, snapshotTree } from './_treediff.js';

// Two bounds, because "long-running" and "stuck" are different shapes (#408). A build or a test
// suite keeps writing for as long as it runs; a command the model should never have started — a
// dev server, `tail -f`, a prompt waiting on stdin — goes silent. So the absolute ceiling is sized
// for real work, and the idle bound is what actually catches the stuck class. Idle equals the old
// absolute default on purpose: anything that finished under it still does. Zero disables either.
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
// After SIGTERM to the group, how long a holdout gets before SIGKILL.
const KILL_GRACE_MS = 2_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 2 * 1024;
const OUTPUT_TAIL_LINES = 10;
// Retained for the UI chip's last-lines view. Larger than OUTPUT_TAIL_BYTES so the slice to 10
// lines always has enough to work with even when lines are long, and small enough to be free.
const UI_TAIL_BYTES = 4 * 1024;
// How much output the spill buffer retains. Big enough that an ordinary build or test run spills
// complete; small enough that a runaway `yes` can't grow the process without bound. Only the
// retained window is held — the drain itself never stops, which is the whole point.
const SPILL_MAX_BYTES = 4 * 1024 * 1024;

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command in the working directory. Prefer the dedicated tools (read, grep, edit, write, list) when they fit; use bash for build, test, lint, git/gh, and similar workflows.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute. Single string, run via /bin/sh.',
      },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) return { summary: 'Bash failed: empty command' };

    // The danger scan runs whether or not there is a modal to raise, because it decides two things
    // now, not one: whether to *ask*, and whether the command runs sandboxed (#163). Hoisted out of
    // the conditional it used to sit in — under `bypass` `requestApproval` is undefined, so the scan
    // never ran, and a sandbox keyed on it would have covered nothing in exactly the autonomous
    // configuration this exists for. The signal was always computed one line before the prompt; this
    // is the same signal feeding both decisions, not a second classifier.
    const warnings = detectDangerousPatterns(command);
    const flagged = warnings.length > 0;
    let approvedByHand = false;
    if (ctx.requestApproval) {
      const ok = await ctx.requestApproval({
        tool: 'bash',
        subject: ctx.cwd,
        preview: command,
        warnings: flagged ? warnings : undefined,
      });
      if (!ok) return { summary: `Bash declined by user: ${command}` };
      approvedByHand = true;
    }

    // One sentence: anything a human didn't look at runs sandboxed. A flagged command is the only
    // kind that needs the network (`npm install`, `git push`, `gh pr create`, `curl | sh` — all
    // already in the danger patterns), and it is exactly the kind a human just cleared. So the
    // sandbox needs no proxy, no package-manager allowlist, and no HTTP layer.
    //
    // `ctx.sandbox === false` is REIKA_SANDBOX=0: an escape hatch for a run that is measuring
    // something about bash behavior and needs the old world back. Undefined means on.
    const sandboxed = ctx.sandbox !== false && !(flagged && approvedByHand);

    // Bracket the run with a working-tree snapshot so an edit made through the shell (`sed -i`, a
    // heredoc, a formatter) gets the same visual diff the edit tool gives (#278). Both halves run
    // in the dispatch gap, off the model's clock, and fail open.
    const snapshot = await snapshotTree(ctx.cwd, command);
    const result = await execStream(command, ctx, sandboxed);
    if (!snapshot) return result;
    const changes = await changesSince(snapshot);
    // Without a repo the detector is the command text, which sees far less. Said once per cwd, on
    // the first shell command there, so the narrower coverage is stated before it's discovered —
    // and never in the model's context, where it could act on none of it.
    //
    // Joined to the sandbox receipt rather than replacing it: on the first command in a non-repo cwd
    // both fire, and picking one would silently drop the other — a fresh directory is exactly where
    // that happens, and it was dropping the sandbox line in the tests below. Only the first command
    // carries this line, so the concatenation cannot accumulate over a session.
    const noRepo = snapshot.root === null && !noRepoNoticed.has(ctx.cwd);
    if (noRepo) noRepoNoticed.add(ctx.cwd);
    const notice = noRepo
      ? {
          tone: result.notice?.tone ?? ('info' as const),
          content: [result.notice?.content, NO_REPO_NOTICE].filter(Boolean).join('\n'),
        }
      : result.notice;
    const { notice: _drop, ...rest } = result;
    return { ...rest, ...(changes ? { changes } : {}), ...(notice ? { notice } : {}) };
  },
};

// Minimal mode's bash (#391). The same tool with the same behavior — only the description differs,
// because the default one opens by telling the model to "prefer the dedicated tools (read, grep,
// edit, write, list) when they fit" and in minimal mode none of those exist. That sentence rides
// the prefix on EVERY round, so it is a worse phantom pointer than the withdrawal directive's:
// that one only appears once a loop is active, this one is in front of the model from round 0.
//
// It replaces the steer rather than just deleting it. The default description's real job is
// routing — when to reach for the shell instead of something else — and in a one-tool mode the
// equivalent job is telling the model this IS the whole surface, so it doesn't spend a round
// discovering that by calling something absent. Named commands rather than a bare "you only have
// bash": a weak model handed a shell and no project context needs somewhere concrete to start,
// and these are the shapes the harness can see (tools/_writetargets.ts) when they mutate.
export const minimalBashTool: Tool = {
  ...bashTool,
  description:
    'Execute a shell command in the working directory. This is your only tool: everything — ' +
    'reading files (cat, sed -n), searching (grep, find), editing (a heredoc, sed -i, or a ' +
    'redirect), building, testing, and git — goes through it. Single string, run via /bin/sh.',
};

const noRepoNoticed = new Set<string>();
const NO_REPO_NOTICE =
  'Not a git repo — a shell edit here shows a diff only for files the command names directly ' +
  '(redirects, sed -i, tee, cp/mv, rm); a formatter or script writing elsewhere shows nothing.';

// Plan mode's bash (#109). The same tool, admitted only for commands `isProvablyReadOnly` can PROVE
// read-only — so plan mode gains the inspection a pipeline expresses (`grep … | head`, `find`, `wc`)
// without gaining a way to mutate the repo. Keeps `name: 'bash'`, so the model needs no second
// dialect and the plan-progress command matching still keys on it, and delegates the run itself so
// spill and timeout behave identically.
//
// A refusal is an ordinary result, not an error: a small model recovers from a stated rule far better
// than from a tool that silently isn't there. It names the rule and the way out but NOT the allowlist
// — that already rides every request in the description above, and a refused model tends to retry, so
// restating 141 chars of it per refusal buys nothing and crowds a small window (cf. the loop's
// WITHDRAWAL_DIRECTIVE, which carries no content for the same reason).
export const readOnlyBashTool: Tool = {
  ...bashTool,
  description:
    'Execute a READ-ONLY shell command in the working directory. Only inspection commands run: ' +
    `${READ_ONLY_COMMAND_LIST}, and pipelines of them. Anything that can write or run something ` +
    'else is refused — redirection (>), command substitution ($(…)), sed/awk, and any command not ' +
    'on that list. Use it for inspection the read/grep/glob/list tools cannot express.',
  async run(args, ctx) {
    const command = String(args.command ?? '').trim();
    if (!command) return { summary: 'Bash failed: empty command' };
    if (!isProvablyReadOnly(command)) {
      return {
        summary:
          `Bash refused (read-only mode): ${command}. It could write or run something off the ` +
          'read-only list. Use read/grep/glob/list, or rewrite it as a read-only pipeline.',
      };
    }
    // No approval prompt, deliberately. `off` is documented as "confirm every MUTATING action"
    // (types.ts AutoApproveMode), and the classifier above has just proved this command mutates
    // nothing — while plan mode's other four tools read arbitrary paths with no prompt at all.
    // Prompting only for bash would gate a capability `read` already has, and would train the user
    // to approve bash modals reflexively, weakening the prompt in agent mode where it carries the
    // real decision. The command still renders its chip in scrollback, so nothing runs unseen.
    // Straight to execStream: a command just proved read-only has no tree diff to take.
    return execStream(command, ctx);
  },
};

// A bounded tail of a stream: push every chunk, retain roughly the last `max` bytes. This is what
// lets bash spill without restructuring the drain — the process keeps writing at full speed and
// only the retained window is capped, so the end of a long run survives instead of the start.
//
// Chunk-granular, not byte-exact: whole chunks are dropped off the front, and the window is only
// trimmed while it would still hold `max` bytes without the front one. So it retains between `max`
// and `max` + one chunk (~64KB against a 4MB budget, under 2% slop) and never drops the only chunk
// it has. Slicing strings on every read would buy exactness nobody can use — the boundary is
// arbitrary either way, since a chunk edge is not a line edge.
export class TailWindow {
  private chunks: string[] = [];
  bytes = 0;

  constructor(private readonly max: number) {}

  push(text: string): void {
    this.chunks.push(text);
    this.bytes += text.length;
    while (this.chunks.length > 1 && this.bytes - this.chunks[0].length >= this.max) {
      this.bytes -= this.chunks.shift()!.length;
    }
  }

  text(): string {
    return this.chunks.join('');
  }
}

// Process groups still running, so a reika exit takes them along: `detached` puts each command in
// its own group (that is what makes the kill below reach the whole pipeline), and a group of its own
// is one the terminal's hangup no longer sweeps up.
const liveGroups = new Set<number>();
process.once('exit', () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
});

type StopReason = 'ceiling' | 'idle' | 'abort';

export type ExecContext = Pick<
  ToolContext,
  'cwd' | 'onProgress' | 'bashTimeoutMs' | 'bashIdleMs' | 'signal'
>;

// A base URL reaching a loopback model server, cached per process. `_sandbox` has no config access
// by design — the profile generator stays pure string-in/string-out so it tests without a config —
// so the one value it needs is read here. `loadConfig` throwing (no REIKA_MODEL) is not this
// function's problem: it just means no local endpoint to allow, and the profile denies all network.
let allowedNetBase: string | null | undefined;

export function resetSandboxNetCache(): void {
  allowedNetBase = undefined;
}

function sandboxBaseURL(): string {
  if (allowedNetBase === undefined) {
    try {
      allowedNetBase = loadConfig().baseURL;
    } catch {
      allowedNetBase = null;
    }
  }
  return allowedNetBase ?? '';
}

export function execStream(
  command: string,
  ctx: ExecContext,
  sandboxed = false,
): Promise<ToolResult> {
  const timeoutMs = ctx.bashTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = ctx.bashIdleMs ?? DEFAULT_IDLE_MS;
  // Resolved before the promise so a profile that cannot be built degrades to today's behavior
  // rather than to a failed command. `sandboxPlan` returns a reason instead of args on every
  // platform that isn't macOS (bubblewrap's `--unshare-net` gives the child its own loopback, so a
  // sandboxed command could not reach the host's model server — the issue's "Linux is a real second
  // project"). There the reason is expected and gets no notice; on macOS it is a machine fault the
  // user should hear about.
  const plan = sandboxed ? sandboxPlan(ctx.cwd, sandboxBaseURL()) : undefined;
  const argv = plan ? sandboxArgv(plan, command) : undefined;
  // Told ONCE, up front — as a UI receipt, never in the model's context. Nothing otherwise announces
  // the sandbox, so without this the model's only evidence is error text it misreads (curl's "could
  // not resolve host" reads as a typo'd URL, git's as a missing key) and the user's only evidence is
  // a command that mysteriously failed.
  const notice: ToolResult['notice'] = argv
    ? {
        tone: 'info',
        content: isBroadWorkdir(ctx.cwd) ? broadWorkdirNotice(ctx.cwd) : sandboxNotice(command),
      }
    : plan && !('args' in plan) && process.platform === 'darwin'
      ? { tone: 'warn', content: `Not sandboxed: ${plan.reason}` }
      : undefined;
  return new Promise(resolve => {
    if (ctx.signal?.aborted) {
      resolve({ summary: `Bash aborted: ${command} (not run)` });
      return;
    }
    // stdin is /dev/null, not a pipe we never write: a command that reads it (`cat`, a `read`, an
    // interactive installer's prompt) gets EOF at once instead of the idle bound five minutes on.
    //
    // Sandboxed, the argv is `sandbox-exec … /bin/sh -c command` — a different program with the same
    // pipes one level down, so exit codes, SIGTERM to the process group, streaming and both timeout
    // bounds behave identically (each verified, #163).
    const proc = argv
      ? spawn(argv.cmd, argv.args, {
          cwd: ctx.cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('/bin/sh', ['-c', command], {
          cwd: ctx.cwd,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    if (proc.pid != null) liveGroups.add(proc.pid);
    const buffer: string[] = [];
    let totalBytes = 0;
    let stopped: StopReason | null = null;
    // Read once at spawn, not per chunk: a flag flipped mid-run would otherwise spill half a
    // command's output and describe it as the whole tail.
    const spilling = spillEnabled();
    // The spill window, kept alongside the payload buffer rather than instead of it. The payload
    // still keeps the HEAD (unchanged, so the flag A/Bs cleanly); this keeps the TAIL, because the
    // case that motivates spilling bash at all — a long test or build run — puts the failure at the
    // end, which is exactly what head-truncation throws away.
    const tail = new TailWindow(SPILL_MAX_BYTES);
    // A second, tiny window for the UI chip, always on and independent of REIKA_SPILL. The chip
    // shows the END of a run (see buildCommandDisplay), and a user watching a build deserves that
    // whether or not the model's artifact was written.
    const uiTail = new TailWindow(UI_TAIL_BYTES);
    // Every byte the process wrote, retained or not. `totalBytes` stops at the payload cap, so it
    // can't answer "of how many?" once truncation kicks in.
    let rawBytes = 0;

    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      armIdle();
      ctx.onProgress?.(text);
      rawBytes += text.length;
      uiTail.push(text);
      if (spilling) tail.push(text);
      if (totalBytes >= MAX_PAYLOAD_BYTES) return;
      const remaining = MAX_PAYLOAD_BYTES - totalBytes;
      const slice = text.length > remaining ? text.slice(0, remaining) : text;
      buffer.push(slice);
      totalBytes += slice.length;
    };

    proc.stdout.on('data', append);
    proc.stderr.on('data', append);

    // Signals go to the group, not to `sh`: `sh -c 'cd x && npm run dev'` forks, and killing only
    // the shell left the server running with our stdout pipe open — 'close' never fired, and the
    // "ceiling" was no bound at all (measured: `sleep 3; echo` killed at 100ms, resolved at 3s).
    const killGroup = (sig: NodeJS.Signals): void => {
      if (proc.pid == null) return;
      try {
        process.kill(-proc.pid, sig);
      } catch {
        try {
          proc.kill(sig);
        } catch {
          // Already gone.
        }
      }
    };
    let killId: NodeJS.Timeout | undefined;
    const stop = (reason: StopReason): void => {
      if (stopped) return;
      stopped = reason;
      killGroup('SIGTERM');
      killId = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const ceilingId = timeoutMs > 0 ? setTimeout(() => stop('ceiling'), timeoutMs) : undefined;
    let idleId: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      clearTimeout(idleId);
      idleId = setTimeout(() => stop('idle'), idleMs);
    };
    armIdle();
    const onAbort = (): void => stop('abort');
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(ceilingId);
      clearTimeout(idleId);
      clearTimeout(killId);
      ctx.signal?.removeEventListener('abort', onAbort);
      if (proc.pid != null) liveGroups.delete(proc.pid);
    };

    proc.on('close', (code, signal) => {
      cleanup();
      const rawOutput = buffer.join('');
      const truncated = totalBytes >= MAX_PAYLOAD_BYTES ? '\n…(truncated)' : '';
      // The sandbox-aware half (#163). Seatbelt's network denials never say "permission" — curl
      // reports a DNS failure, git/npm report credentials or proxy problems — so a headerless failure
      // reads to a model as a bug in its own command and sets up the classic spiral. Keyed on the
      // exit status, so a flagged (`npm install`) command that deliberately ran unsandboxed gets no
      // sandbox line to chase.
      const base =
        (rawOutput + truncated || '(no output)') +
        searchHint(command, rawOutput) +
        (argv ? sandboxFooter(command, code) : '');
      // Built from the retained tail, not the payload head: the chip is the user's answer to "how
      // did it end?", which the head cannot give once a run passes the cap.
      const display = buildCommandDisplay(command, uiTail.text(), rawBytes > uiTail.bytes);
      // The real size, unconditionally. `totalBytes` stops counting at the payload cap, so with
      // spill off the summary told the model a 234KB run "produced 65536 bytes" — a claim about
      // the command's output, not about how much of it we kept, and false either way. This was
      // gated on `spilling` to keep the flag a byte-identical A/B; the payload still is, and a
      // wrong number in the model's context is not worth the tidiness of that claim.
      const reported = rawBytes;
      const done = (payload: string): void => {
        if (stopped) {
          // Loud, and in the payload as well as the summary: a model that reads a killed command
          // as a slow one re-runs it as is, and the idle case is the one where that never ends.
          const [summary, note] = stoppedResult(command, stopped, timeoutMs, idleMs);
          resolve({
            summary,
            payload: `${payload}\n${note}`,
            command: display,
            exitCode: code,
            ...(notice ? { notice } : {}),
          });
        } else {
          // The status is *surfaced*, not reclassified (#200). A non-zero exit used to read
          // `Bash failed:`, which is wrong for the many commands that exit non-zero as ordinary
          // control flow — grep with no match, diff with differences, git diff --quiet, a test
          // runner reporting red. Calling those failures teaches the model to retry a command that
          // did exactly what it was asked. It still must not read as success either, which is what
          // the old code did before the exit check existed: an added `(exit 1, …)` slot says what
          // happened without judging it. A timeout and a spawn error keep their `Bash` prefixes —
          // there the command genuinely did not run to completion.
          const status = code === 0 ? '' : signal ? `killed by ${signal}, ` : `exit ${code}, `;
          resolve({
            summary: `Ran: ${command} (${status}${reported} bytes output)`,
            payload,
            command: display,
            exitCode: code,
            ...(notice ? { notice } : {}),
          });
        }
      };
      // A bad profile exits 65 without running anything — the sandbox fails CLOSED, which is the
      // opposite of what a fail-open feature wants: one bug in the generator would otherwise turn
      // every command into an uninterpretable failure. Retried unsandboxed, exactly once.
      if (
        argv &&
        code === SANDBOX_PROFILE_ERROR_CODE &&
        rawOutput.includes(SANDBOX_EXEC_ERROR_PREFIX)
      ) {
        execStream(command, ctx, false).then(resolve);
        return;
      }
      // Recorded whether or not spilling is on: the question this answers is how often bash
      // output exceeds the cap at all, which is a property of the workload, not of the flag. The
      // spilling arm records below instead, after the write, so `spilled` reports whether an
      // artifact actually landed rather than whether one was intended.
      if (rawBytes > MAX_PAYLOAD_BYTES && !spilling) {
        recordCapped({ tool: 'bash', total: rawBytes, shown: totalBytes, spilled: false });
      }
      // Nothing was held back (or spilling is off): the ordinary result, byte-identical to the
      // pre-spill behavior so the flag is a clean A/B — including staying synchronous.
      if (!spilling || rawBytes <= MAX_PAYLOAD_BYTES) {
        done(base);
        return;
      }
      void (async () => {
        const complete = tail.bytes >= rawBytes;
        const ref = await spillResult('bash', tail.text());
        recordCapped({
          tool: 'bash',
          total: rawBytes,
          shown: totalBytes,
          spilled: !!ref,
          // Whether the 4MB window held the whole run. A stream of `complete: false` lines is the
          // evidence that SPILL_MAX_BYTES is too small; none of them means it is generous. Only a
          // claim the run can make when the window was actually saved.
          complete: ref ? complete : undefined,
        });
        const shared = { shown: totalBytes, total: String(rawBytes), unit: 'bytes' };
        done(
          base +
            (ref
              ? buildSpillFooter({
                  ...shared,
                  ref,
                  subject: 'command',
                  saved: complete
                    ? 'Full output'
                    : `The last ${tail.bytes} bytes (the middle was dropped)`,
                  note: complete
                    ? undefined
                    : 'The output above is the start of the run; the file holds the end.',
                })
              : buildCappedFooter({
                  ...shared,
                  advice: 'narrow the output (pipe through `tail` or `grep`) and run it again',
                })),
        );
      })();
    });

    proc.on('error', err => {
      cleanup();
      resolve({
        summary: `Bash failed: ${command} (${err.message})`,
        payload: buffer.join('') || err.message,
        command: buildCommandDisplay(command, buffer.join('') || err.message, false),
      });
    });
  });
}

function stoppedResult(
  command: string,
  reason: StopReason,
  timeoutMs: number,
  idleMs: number,
): [summary: string, note: string] {
  switch (reason) {
    case 'ceiling':
      return [
        `Bash timeout: ${command} (killed after ${timeoutMs / 1000}s)`,
        `…(killed: hit the ${timeoutMs / 1000}s ceiling. Narrow the command or run part of it.)`,
      ];
    case 'idle':
      return [
        `Bash timeout: ${command} (no output for ${idleMs / 1000}s, killed)`,
        `…(killed: no output for ${idleMs / 1000}s — the command hangs or never exits, ` +
          'such as a server or a watcher. Do not re-run it as is.)',
      ];
    case 'abort':
      return [`Bash aborted: ${command} (killed by user)`, '…(killed by the user)'];
  }
}

// A bare line-search (grep/rg/etc.) returns only matching lines, never the surrounding
// code. Weak models tend to re-run the search with new flags instead of opening the file.
// When the output carries line numbers, append a one-line nudge to read those locations.
// Fires only when line numbers are present (so there's somewhere concrete to point), and is
// harmless if shown — it's a hint, not a command result.
const SEARCH_CMD_RE = /\b(?:e?grep|fgrep|rg|ag|ack)\b/;
const LINE_PREFIXED_RE = /^(?:[^\n:]*:)?\d+[:-]/m;

function searchHint(command: string, output: string): string {
  if (!SEARCH_CMD_RE.test(command) || !LINE_PREFIXED_RE.test(output)) return '';
  return (
    '\n\n(reika: these are matching lines only, not the full file. Use the read tool at the ' +
    'listed line numbers to see the surrounding code instead of re-running the search.)'
  );
}

// The chip under a command in the TUI: its last few lines, and whether anything came before them.
//
// `retained` must be the END of the run, not the head the payload keeps. It used to be fed the
// capped payload, so a truncated command showed the last 10 lines of the first 64KB — content from
// the MIDDLE of the run, presented where a reader looks for how it ended. Nothing about that was
// false (the marker did say more was omitted), but on `npm test` it meant showing test 4300 of
// 9000 instead of the failure. The end is what a human wants for the same reason the model does.
//
// `omittedEarlier` covers the bytes dropped before the retained window, which the window itself
// cannot see — without it a full 4KB window looks indistinguishable from a 4KB run.
function buildCommandDisplay(
  command: string,
  retained: string,
  omittedEarlier: boolean,
): { text: string; outputTail: string; outputTruncated: boolean } {
  if (!retained) return { text: command, outputTail: '', outputTruncated: false };
  const byteTail =
    retained.length > OUTPUT_TAIL_BYTES
      ? retained.slice(retained.length - OUTPUT_TAIL_BYTES)
      : retained;
  const lines = byteTail.split('\n');
  const lineTail = lines.slice(-OUTPUT_TAIL_LINES);
  const outputTruncated =
    omittedEarlier || retained.length > byteTail.length || lines.length > OUTPUT_TAIL_LINES;
  return { text: command, outputTail: lineTail.join('\n'), outputTruncated };
}

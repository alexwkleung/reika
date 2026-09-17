import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import { detectDangerousPatterns } from './_danger.js';
import { recordCapped } from './_spillstats.js';
import { READ_ONLY_COMMAND_LIST, isProvablyReadOnly } from './_readonly.js';
import { changesSince, snapshotTree } from './_treediff.js';

const DEFAULT_TIMEOUT_MS = 300_000;
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

    if (ctx.requestApproval) {
      const warnings = detectDangerousPatterns(command);
      const ok = await ctx.requestApproval({
        tool: 'bash',
        subject: ctx.cwd,
        preview: command,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
      if (!ok) return { summary: `Bash declined by user: ${command}` };
    }

    // Bracket the run with a working-tree snapshot so an edit made through the shell (`sed -i`, a
    // heredoc, a formatter) gets the same visual diff the edit tool gives (#278). Both halves run
    // in the dispatch gap, off the model's clock, and fail open.
    const snapshot = await snapshotTree(ctx.cwd, command);
    const result = await execStream(command, ctx, ctx.bashTimeoutMs);
    if (!snapshot) return result;
    const changes = await changesSince(snapshot);
    // Without a repo the detector is the command text, which sees far less. Said once per cwd, on
    // the first shell command there, so the narrower coverage is stated before it's discovered —
    // and never in the model's context, where it could act on none of it.
    const notice =
      snapshot.root === null && !noRepoNoticed.has(ctx.cwd)
        ? { tone: 'info' as const, content: NO_REPO_NOTICE }
        : undefined;
    if (notice) noRepoNoticed.add(ctx.cwd);
    return { ...result, ...(changes ? { changes } : {}), ...(notice ? { notice } : {}) };
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
    return execStream(command, ctx, ctx.bashTimeoutMs);
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

export function execStream(
  command: string,
  ctx: { cwd: string; onProgress?: (chunk: string) => void },
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ToolResult> {
  return new Promise(resolve => {
    const proc = spawn('/bin/sh', ['-c', command], { cwd: ctx.cwd });
    const buffer: string[] = [];
    let totalBytes = 0;
    let timedOut = false;
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

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      const rawOutput = buffer.join('');
      const truncated = totalBytes >= MAX_PAYLOAD_BYTES ? '\n…(truncated)' : '';
      const base = (rawOutput + truncated || '(no output)') + searchHint(command, rawOutput);
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
        if (timedOut) {
          resolve({
            summary: `Bash timeout: ${command} (killed after ${timeoutMs / 1000}s)`,
            payload,
            command: display,
            exitCode: code,
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
          });
        }
      };
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
      clearTimeout(timeoutId);
      resolve({
        summary: `Bash failed: ${command} (${err.message})`,
        payload: buffer.join('') || err.message,
        command: buildCommandDisplay(command, buffer.join('') || err.message, false),
      });
    });
  });
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

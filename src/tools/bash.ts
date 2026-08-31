import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';
import { buildCappedFooter, buildSpillFooter, spillEnabled, spillResult } from './_spill.js';
import { recordCapped } from './_spillstats.js';

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
      // output exceeds the cap at all, which is a property of the workload, not of the flag.
      if (rawBytes > MAX_PAYLOAD_BYTES) {
        recordCapped({
          tool: 'bash',
          total: rawBytes,
          shown: totalBytes,
          spilled: spilling,
          // Whether the 4MB window held the whole run. A stream of `complete: false` lines is the
          // evidence that SPILL_MAX_BYTES is too small; none of them means it is generous.
          complete: spilling ? tail.bytes >= rawBytes : undefined,
        });
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

// Workflow-policy commands: not destructive (a commit is local and reversible, a push is
// recoverable), but they record or publish work, and the user generally wants to stay in the
// loop rather than have the agent do it autonomously. These funnel through the same warnings
// mechanism as the destructive patterns below — so under 'safe' auto-approve they force a
// prompt, and only explicit 'bypass' lets them run unattended. Kept as a separate constant
// from the genuinely-dangerous patterns so the safety/policy distinction stays visible.
const POLICY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bgit\s+commit\b/, label: 'Git commit (records to version history)' },
  // Bare push; force push is also flagged separately below as a destructive pattern.
  { re: /\bgit\s+push\b/, label: 'Git push (publishes commits to remote)' },
  // Outward-facing GitHub/HF actions. Scoped to the publishing subcommands so read-only
  // invocations (gh pr view, gh run list, hf download) don't trip the gate — blanket gh/hf
  // matching would fire on reads and erode the signal. Remote *deletions* are destructive,
  // not policy, so they live in DANGER_PATTERNS below.
  { re: /\bgh\s+pr\s+(?:create|merge)\b/, label: 'GitHub PR create/merge (outward-facing)' },
  { re: /\bgh\s+release\s+create\b/, label: 'GitHub release create (publishes)' },
  { re: /\bhf\s+upload\b/, label: 'Hugging Face upload (publishes to hub)' },
];

// Package management at ANY scope: installs, uninstalls, and registry-fetch-and-run (npx and
// friends). Every ecosystem runs install-time scripts, so an install is arbitrary code execution
// chosen by the model, and the package it picks may be hallucinated, typosquatted, or outright
// malicious. Deliberately not limited to commands that name a package: a bare `npm install`
// builds from a manifest the model may have just edited, and a lockfile install still runs
// lifecycle scripts. The global-install patterns stay separate because those also change state
// outside the project — a global install trips both and reads as both.
// The trailing (?![\w./-]) keeps the verb a whole token, so `npm run install-hooks` and
// `cat install.md` don't read as installs.
const PACKAGE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:npm|pnpm|bun)\s+(?:-{1,2}[\w-]+\s+)*(?:install|i|add|ci)(?![\w./-])/,
    label: 'Package install (npm/pnpm/bun)',
  },
  {
    re: /\byarn\s+(?:-{1,2}[\w-]+\s+)*(?:install|add)(?![\w./-])/,
    label: 'Package install (yarn)',
  },
  {
    re: /\b(?:pip|pip3)\s+(?:-{1,2}[\w-]+\s+)*install(?![\w./-])/,
    label: 'Python package install (pip)',
  },
  {
    re: /\bpython[\d.]*\s+-m\s+pip\s+(?:-{1,2}[\w-]+\s+)*install(?![\w./-])/,
    label: 'Python package install (pip)',
  },
  {
    re: /\buv\s+(?:pip\s+install|add|sync)(?![\w./-])/,
    label: 'Python package install (uv)',
  },
  {
    re: /\b(?:poetry|pipenv)\s+(?:install|add)(?![\w./-])/,
    label: 'Python package install (poetry/pipenv)',
  },
  { re: /\bcargo\s+add\b/, label: 'Rust package install (cargo add)' },
  { re: /\bgo\s+get\b/, label: 'Go module install (go get)' },
  {
    re: /\b(?:bundle|composer)\s+(?:install|add|require)(?![\w./-])/,
    label: 'Package install (bundler/composer)',
  },
  {
    re: /\b(?:apt|apt-get|dnf|yum|zypper|apk|choco|scoop|winget|port)\s+(?:-{1,2}[\w-]+\s+)*(?:install|add)(?![\w./-])/,
    label: 'System package install (persistent system change)',
  },
  { re: /\bpacman\s+-S[yu]*\b/, label: 'System package install (persistent system change)' },

  // Uninstalls — the mirror of an install, and just as much the user's call: the model can rip
  // out a dependency the project still needs, remove-hooks run the same arbitrary code, and the
  // system-level ones reach outside the repo entirely.
  {
    re: /\b(?:npm|pnpm|bun|yarn)\s+(?:-{1,2}[\w-]+\s+)*(?:uninstall|remove|rm|un)(?![\w./-])/,
    label: 'Package uninstall (npm/pnpm/yarn/bun)',
  },
  {
    re: /\b(?:pip|pip3)\s+(?:-{1,2}[\w-]+\s+)*uninstall(?![\w./-])/,
    label: 'Python package uninstall (pip)',
  },
  {
    re: /\bpython[\d.]*\s+-m\s+pip\s+(?:-{1,2}[\w-]+\s+)*uninstall(?![\w./-])/,
    label: 'Python package uninstall (pip)',
  },
  {
    re: /\b(?:uv|poetry|pipenv)\s+(?:tool\s+)?(?:remove|uninstall)(?![\w./-])/,
    label: 'Python package uninstall (uv/poetry/pipenv)',
  },
  {
    re: /\b(?:brew|pipx|cargo|gem|composer|bundle|go)\s+(?:uninstall|remove)(?![\w./-])/,
    label: 'Package uninstall (global tool)',
  },
  {
    re: /\b(?:apt|apt-get|dnf|yum|zypper|apk|choco|scoop|winget|port)\s+(?:-{1,2}[\w-]+\s+)*(?:uninstall|remove|purge|del)(?![\w./-])/,
    label: 'System package uninstall (persistent system change)',
  },
  { re: /\bpacman\s+-R[a-z]*\b/, label: 'System package uninstall (persistent system change)' },

  // Fetch-and-run: no install, same vector. `npx some-cli` downloads a package the model chose
  // — hallucinated or typosquatted just as easily as one it would have installed — and executes
  // it immediately, so it gets the same gate.
  {
    re: /\b(?:npx|bunx|uvx)(?![\w./-])/,
    label: 'Remote package execution (npx/bunx/uvx)',
  },
  {
    re: /\b(?:pnpm|yarn)\s+dlx(?![\w./-])|\bpipx\s+run(?![\w./-])/,
    label: 'Remote package execution (dlx/pipx run)',
  },
];

// Fallback for the package managers not worth enumerating (conda, mix, gcloud components, a
// project's own `make install`): any command whose verb is `install` or `uninstall`. A couple of
// leading tokens are allowed so wrappers still match (`sudo apt install`, `python -m pip
// install`), and it is only reported when no specific package pattern fired — see
// detectDangerousPatterns. Matching is per shell segment, because the verb position is what
// makes this precise: `grep -rn install src/` passes `install` as an *argument*, and the
// read-only leads below never install anything, so they are skipped outright.
const GENERIC_PACKAGE_RE = /^(?:\S+\s+){1,3}?(?:-{1,2}[\w-]+\s+)*(un)?install(?![\w./-])/;
const READ_ONLY_LEAD_RE =
  /^(?:e?grep|fgrep|rg|ag|ack|find|man|which|type|whereis|cat|bat|less|more|head|tail|awk|sed|echo|printf|ls|wc|git)\b/;

function genericPackageLabel(command: string): string | undefined {
  for (const segment of command.split(/[;&|]+/)) {
    const seg = segment.trim();
    if (!seg || READ_ONLY_LEAD_RE.test(seg)) continue;
    const m = GENERIC_PACKAGE_RE.exec(seg);
    if (m) {
      return m[1]
        ? 'Uninstall command (removes third-party code)'
        : 'Install command (fetches and runs third-party code)';
    }
  }
  return undefined;
}

const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
    label: 'Recursive force delete (rm -rf)',
  },
  { re: /\bsudo\b/, label: 'Privilege escalation (sudo)' },
  { re: /(curl|wget)[^|]*\|\s*(sh|bash|zsh)\b/, label: 'Piping remote content to shell' },
  { re: /\|\s*(sh|bash|zsh)\b/, label: 'Piping to shell' },
  { re: /\bdd\s+[^&;|]*\bof=\/dev\//, label: 'Direct device write (dd of=/dev/…)' },
  {
    re: /\bgit\s+push[^&;|]*(--force\b|--force-with-lease\b|\s-f\b)/,
    label: 'Force push to remote',
  },
  { re: /\bgit\s+branch\s+-D\b/, label: 'Force-delete git branch' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'Hard reset (discards uncommitted changes)' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'Force-clean untracked files' },
  { re: /\bgh\s+repo\s+delete\b/, label: 'Delete GitHub repo (irreversible remote)' },
  { re: /\bhf\s+repo\s+delete\b/, label: 'Delete Hugging Face repo (irreversible remote)' },
  { re: /\bchmod\s+[0-7]*777\b/, label: 'Open permissions (chmod 777)' },
  { re: /\brm\s+[^&;|]*\.env\b/, label: 'Deleting environment file (.env)' },
  { re: />\s*\/dev\/sd[a-z]\b/, label: 'Writing to raw disk device' },
  { re: /:(){:|:&};:|:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: 'Fork bomb pattern' },
  // Global / persistent package installs — affect state outside the project
  {
    re: /\bnpm\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global npm install (persistent system change)',
  },
  {
    re: /\bnpm\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global npm install (persistent system change)',
  },
  {
    re: /\bpnpm\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global pnpm install (persistent system change)',
  },
  {
    re: /\bpnpm\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global pnpm install (persistent system change)',
  },
  { re: /\byarn\s+global\s+add\b/, label: 'Global yarn install (persistent system change)' },
  {
    re: /\bbun\s+(?:install|i|add)\b[^|;&]*\s-{1,2}g(?:lobal)?\b/,
    label: 'Global bun install (persistent system change)',
  },
  {
    re: /\bbun\s+-{1,2}g(?:lobal)?\b[^|;&]*\b(?:install|i|add)\b/,
    label: 'Global bun install (persistent system change)',
  },
  { re: /\bbrew\s+install\b/, label: 'Homebrew install (system-level)' },
  { re: /\bcargo\s+install\b/, label: 'Cargo install (global binary)' },
  { re: /\bgo\s+install\b/, label: 'Go install (global $GOBIN)' },
  { re: /\bpipx\s+install\b/, label: 'pipx install (global Python tool)' },
  { re: /\buv\s+tool\s+install\b/, label: 'uv tool install (global Python tool)' },
  { re: /\bgem\s+install\b/, label: 'Gem install (Ruby package)' },
  ...PACKAGE_PATTERNS,
  ...POLICY_PATTERNS,
];

export function detectDangerousPatterns(command: string): string[] {
  const hits: string[] = [];
  for (const { re, label } of DANGER_PATTERNS) {
    if (re.test(command) && !hits.includes(label)) hits.push(label);
  }
  // The long-tail fallback only speaks up when nothing more specific did, so a `pip install`
  // reports one precise label instead of two overlapping ones. Every install/uninstall label
  // above contains the word, which is what makes this cheap test sufficient.
  if (!hits.some(h => /install/i.test(h))) {
    const generic = genericPackageLabel(command);
    if (generic) hits.push(generic);
  }
  return hits;
}

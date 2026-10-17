import { spillResult, type SpillRef } from '../tools/_spill.js';

// Shell-mode runs the model should see. A command the user runs in shell mode used to land in the
// scrollback only, so "fix that" after a red `pnpm test` reached a model that never saw the run and
// re-ran it. The runs are held here and prepended to the next prompt, rather than sent as their own
// messages: a bare output blob with no request beside it reads to a small model as the task.

// Bounded by the window, the way the repo map is (#670): a 16k context gets ~1KB a run, a large one
// 4KB. With no window known the floor applies, erring small.
export const SHELL_RUN_MIN_CHARS = 1024;
export const SHELL_RUN_MAX_CHARS = 4096;
const WINDOW_DIVISOR = 16;
// Runs held at once; past it the oldest drops whole. Their command lines alone are cheap, but a
// session of fifty `ls` calls before one prompt is still fifty lines of noise.
export const MAX_HELD_SHELL_RUNS = 12;
// Below this a slice of output says nothing a command line and exit code don't.
const MIN_TAIL_CHARS = 160;
const MAX_COMMAND_CHARS = 300;

export type ShellRun = {
  command: string;
  exitCode: number | null;
  output: string;
  // The full output, saved when it was longer than the largest slice a run can get.
  spill?: SpillRef;
};

export type ShellRunBudget = { perRun: number; total: number };

export function shellRunBudget(contextWindow?: number): ShellRunBudget {
  const perRun = contextWindow
    ? Math.min(
        SHELL_RUN_MAX_CHARS,
        Math.max(SHELL_RUN_MIN_CHARS, Math.round(contextWindow / WINDOW_DIVISOR)),
      )
    : SHELL_RUN_MIN_CHARS;
  return { perRun, total: perRun * 2 };
}

export async function captureShellRun(
  command: string,
  exitCode: number | null,
  output: string,
): Promise<ShellRun> {
  const spill =
    output.length > SHELL_RUN_MIN_CHARS
      ? ((await spillResult('shell', output)) ?? undefined)
      : undefined;
  return { command, exitCode, output, ...(spill ? { spill } : {}) };
}

export function holdShellRun(held: ShellRun[], run: ShellRun): ShellRun[] {
  return [...held, run].slice(-MAX_HELD_SHELL_RUNS);
}

// Newest first gets the budget: the run the user just did is the one their prompt is about.
export function buildShellRunsBlock(runs: ShellRun[], budget: ShellRunBudget): string {
  if (runs.length === 0) return '';
  let remaining = budget.total;
  const shares = new Array<number>(runs.length).fill(0);
  for (let i = runs.length - 1; i >= 0; i--) {
    const share = Math.min(budget.perRun, remaining, runs[i].output.trimEnd().length);
    if (share < MIN_TAIL_CHARS && share < runs[i].output.trimEnd().length) continue;
    shares[i] = share;
    remaining -= share;
  }
  const parts = [
    '<shell-runs>',
    'The user ran these commands themselves in shell mode before this message. They are context, not a request.',
  ];
  runs.forEach((run, i) => parts.push(renderRun(run, shares[i])));
  parts.push('</shell-runs>');
  return parts.join('\n');
}

function renderRun(run: ShellRun, share: number): string {
  const command =
    run.command.length > MAX_COMMAND_CHARS
      ? `${run.command.slice(0, MAX_COMMAND_CHARS)}…`
      : run.command;
  const status = run.exitCode === null ? 'killed' : `exit ${run.exitCode}`;
  const lines = [`$ ${command}  (${status})`];
  const output = run.output.trimEnd();
  if (!output) {
    lines.push('(no output)');
    return lines.join('\n');
  }
  if (share === 0) {
    lines.push(`(${output.length} chars of output omitted${locator(run)})`);
    return lines.join('\n');
  }
  if (output.length <= share) {
    lines.push(output);
    return lines.join('\n');
  }
  // Cut at a line boundary: a run's verdict sits at its end, and a half line at the top is noise.
  const slice = output.slice(-share);
  const nl = slice.indexOf('\n');
  const tail = nl >= 0 && nl < slice.length - 1 ? slice.slice(nl + 1) : slice;
  lines.push(`…(earlier output omitted${locator(run)})`, tail);
  return lines.join('\n');
}

function locator(run: ShellRun): string {
  return run.spill ? `; full output saved to ${run.spill.path}, read it with offset/limit` : '';
}

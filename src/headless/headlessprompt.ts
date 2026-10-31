import { openSync, createReadStream, createWriteStream } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { APPROVAL_FEEDBACK_INDEX, APPROVAL_OPTIONS, type ConfirmSpec } from '../ui/dialogspecs.js';
import { toolLabel } from '../ui/format.js';
import type { ApprovalAnswer, ApprovalRequest, QuestionAnswer, QuestionRequest } from '../types.js';

// Headless dialogs (#872): `reika -p -i` asks what the TUI would have opened a dialog for, as a
// numbered menu on the controlling terminal. The terminal, not stdin/stderr: stdin may be the piped
// prompt and stderr a log file, and a question written into a log waits for an answer nobody sees.

// Rows of an approval preview printed before the menu. The TUI fits the preview to the pane; a
// line prompt has no pane, and a 400-line diff scrolls the menu off the screen.
export const PREVIEW_LINES = 40;

export type HeadlessPrompter = {
  // The row picked (0-based), or null on EOF / abort. Empty input picks `defaultIndex`.
  choose: (header: string[], options: string[], defaultIndex: number) => Promise<number | null>;
  // A line of free text; null on EOF / abort.
  ask: (prompt: string) => Promise<string | null>;
  close: () => void;
};

// The controlling terminal, or null when there is none (cron, CI, `setsid`) — the caller then
// refuses `--interactive` rather than hanging on a read that never completes.
export function openTerminalPrompter(signal?: AbortSignal): HeadlessPrompter | null {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return null;
  }
  // The read stream owns the fd: destroying it closes the fd, so the write side must not.
  const input = createReadStream('', { fd });
  const output = createWriteStream('', { fd, autoClose: false });
  const prompter = createPrompter(input, output, signal);
  return {
    ...prompter,
    close: () => {
      prompter.close();
      output.destroy();
      input.destroy();
    },
  };
}

export function createPrompter(
  input: Readable,
  output: Writable,
  signal?: AbortSignal,
): HeadlessPrompter {
  const rl: Interface = createInterface({ input, output, terminal: false });
  let closed = false;
  rl.once('close', () => (closed = true));
  // Answers are read one at a time: two approvals in one round must not share a typed line.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };
  const line = (prompt: string): Promise<string | null> =>
    new Promise(resolve => {
      if (closed || signal?.aborted) return resolve(null);
      const onClose = (): void => resolve(null);
      rl.once('close', onClose);
      rl.question(prompt, { signal }, answer => {
        rl.off('close', onClose);
        resolve(answer);
      });
      signal?.addEventListener('abort', () => resolve(null), { once: true });
    });
  const write = (text: string): void => {
    if (!closed) output.write(text);
  };

  return {
    choose: (header, options, defaultIndex) =>
      serial(async () => {
        write(`\n${header.join('\n')}\n`);
        options.forEach((o, i) =>
          write(`  ${i + 1}. ${o}${i === defaultIndex ? '  (default)' : ''}\n`),
        );
        for (;;) {
          const answer = await line(`choose 1-${options.length}: `);
          if (answer === null) return null;
          const picked = parseChoice(answer, options.length, defaultIndex);
          if (picked !== null) return picked;
          write(`  enter a number from 1 to ${options.length}\n`);
        }
      }),
    ask: prompt => serial(() => line(prompt)),
    close: () => rl.close(),
  };
}

export function parseChoice(answer: string, count: number, defaultIndex: number): number | null {
  const t = answer.trim();
  if (t === '') return defaultIndex;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= count ? n - 1 : null;
}

export function approvalHeader(req: ApprovalRequest): string[] {
  const lines = req.preview.split('\n');
  const shown = lines.slice(0, PREVIEW_LINES);
  return [
    `reika: approve ${toolLabel(req.tool)}? ${req.subject}`,
    ...(req.warnings ?? []).map(w => `  ▲ ${w}`),
    ...shown.map(l => `  │ ${l}`),
    ...(lines.length > shown.length ? [`  │ … ${lines.length - shown.length} more lines`] : []),
  ];
}

// `always` is set when the user picks "Always (this session)": the caller switches its policy to
// 'safe', which — as in the TUI — still asks about anything the danger scan flagged.
export async function askApproval(
  prompter: HeadlessPrompter,
  req: ApprovalRequest,
): Promise<{ answer: ApprovalAnswer; always: boolean }> {
  const picked = await prompter.choose(approvalHeader(req), [...APPROVAL_OPTIONS], 0);
  if (picked === null || picked === 1) return { answer: false, always: false };
  if (picked === 0) return { answer: true, always: false };
  if (picked === APPROVAL_FEEDBACK_INDEX) {
    const reason = (await prompter.ask('what should it do instead? ')) ?? '';
    return { answer: reason.trim() ? { feedback: reason.trim() } : false, always: false };
  }
  return { answer: true, always: true };
}

// The last row is the TUI's "type your own answer" field; a typed answer carries no index.
export async function askQuestion(
  prompter: HeadlessPrompter,
  req: QuestionRequest,
): Promise<QuestionAnswer | null> {
  const labels = req.options.map(o =>
    [o.label, o.recommended ? '(recommended)' : '', o.description ? `— ${o.description}` : '']
      .filter(Boolean)
      .join(' '),
  );
  const own = labels.length;
  const recommended = req.options.findIndex(o => o.recommended);
  const picked = await prompter.choose(
    [`reika: the model asks: ${req.question}`],
    [...labels, 'Type my own answer'],
    recommended >= 0 ? recommended : 0,
  );
  if (picked === null) return null;
  if (picked === own) {
    const text = (await prompter.ask('your answer: '))?.trim();
    return text ? { text } : null;
  }
  return { text: req.options[picked].label, index: picked };
}

// The two-row confirms (skill route, pasted link). Row 0 is "send as typed" and the default, as in
// the TUI: nothing has happened yet, so the least action is the safe one. True accepts row 1.
export async function askConfirm(
  prompter: HeadlessPrompter,
  spec: ConfirmSpec,
): Promise<boolean | null> {
  const picked = await prompter.choose(
    [`reika: ${spec.title} — ${spec.subtitle}`, ...spec.details.map(d => `  ${d}`)],
    spec.options,
    0,
  );
  return picked === null ? null : picked === 1;
}

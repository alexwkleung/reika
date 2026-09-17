import type { DefaultMode } from './types.js';

// The `-p` command line (#52), kept apart from the runner so cli.tsx can decide which front-end
// to start without loading the agent loop for a TUI session or Ink for a headless one.

export type HeadlessMode = DefaultMode | 'chat';

export type HeadlessArgs = {
  // Absent when `-p` was given bare: the prompt is then read from stdin, so a run can be piped.
  prompt?: string;
  mode?: HeadlessMode;
  // Print every message the turn appended as a JSON array instead of the final reply text.
  json: boolean;
  // Write the transcript to the history dir, the way /save does.
  save: boolean;
  help: boolean;
};

export const HEADLESS_USAGE = `usage: reika -p [prompt] [--mode agent|plan|vibe|minimal|chat] [--json] [--save]

  -p, --prompt [text]   run one turn without the TUI; reads stdin when no text is given
  --mode <mode>         which mode the turn runs as (default: REIKA_DEFAULT_MODE, else agent)
  --json                print the turn's messages as a JSON array instead of the reply text
  --save                save the transcript to ~/.config/reika/history like /save
  -h, --help            show this

A prompt starting with /<skill> runs that skill. Approvals follow REIKA_AUTO_APPROVE: with no
prompt to fall back on, anything 'safe' would have asked about is declined, and 'off' declines
every edit and command. ask_user is never offered. Exit status: 0 on a reply, 1 on an error,
130 when interrupted.`;

const MODES: ReadonlySet<string> = new Set(['agent', 'plan', 'vibe', 'minimal', 'chat']);

// Returns null when the argv holds no headless request, so the caller starts the TUI. Throws on
// a flag it doesn't know: silently ignoring one would run the wrong turn with no way to notice.
export function parseHeadlessArgs(argv: string[]): HeadlessArgs | null {
  const args: HeadlessArgs = { json: false, save: false, help: false };
  let headless = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--prompt') {
      headless = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        args.prompt = next;
        i++;
      }
    } else if (a === '--mode') {
      const value = argv[++i];
      if (!value || !MODES.has(value)) {
        throw new Error(`--mode needs one of ${[...MODES].join(', ')}`);
      }
      args.mode = value as HeadlessMode;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--save') {
      args.save = true;
    } else if (a === '-h' || a === '--help') {
      args.help = true;
      headless = true;
    } else if (a.startsWith('-')) {
      throw new Error(`unknown flag ${a}\n${HEADLESS_USAGE}`);
    } else if (headless && args.prompt === undefined) {
      // `reika -p --json "text"` — a positional after the flags is still the prompt.
      args.prompt = a;
    } else {
      throw new Error(`unexpected argument ${a}\n${HEADLESS_USAGE}`);
    }
  }
  return headless ? args : null;
}

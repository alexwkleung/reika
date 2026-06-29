export type CommandSpec = {
  name: string;
  desc: string;
};

export const COMMANDS: CommandSpec[] = [
  { name: 'help', desc: 'show this list' },
  { name: 'new', desc: 'reset conversation, tokens, mode' },
  { name: 'clear', desc: 'alias of /new' },
  { name: 'cd', desc: 'change cwd (re-indexes repo map)' },
  { name: 'shell', desc: 'enter shell mode (raw bash, no model)' },
  { name: 'chat', desc: 'enter chat mode (no filesystem/shell tools; isolated context)' },
  { name: 'plan', desc: 'enter plan mode (read-only exploration; ends with a written plan)' },
  { name: 'agent', desc: 'return to agent mode' },
  { name: 'implement', desc: 'switch to agent mode and execute the plan above' },
  { name: 'model', desc: 'show current model and base URL' },
  { name: 'approvals', desc: 'show/toggle session auto-approve (on|off)' },
  { name: 'cwd', desc: 'show working directory' },
  { name: 'tokens', desc: 'show token usage this session' },
  { name: 'skills', desc: 'list available skills (loaded from skills dirs)' },
  { name: 'stats', desc: 'show full session summary' },
  {
    name: 'save',
    desc: 'save the full conversation to ~/.config/reika/history (--raw skips redaction)',
  },
  { name: 'exit', desc: 'exit Reika' },
  { name: 'quit', desc: 'alias of /exit' },
];

// The model-facing prompt for /implement. Kept short and directive — the target is small local
// models, and the plan it refers to ("the plan above") is already in history (kept verbatim by the
// plan→agent handoff distillation), so this only has to point at it and set the working style.
// Any trailing /implement args become explicit additional guidance.
export function buildImplementPrompt(extra: string): string {
  const base =
    'Implement the plan above. Work through it step by step, making the edits to the files it names.';
  const trimmed = extra.trim();
  return trimmed ? `${base}\n\nAdditional guidance: ${trimmed}` : base;
}

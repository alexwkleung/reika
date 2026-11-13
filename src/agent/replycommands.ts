import { buildSummary, hasActivity, type Approvals } from '../ui/summary.js';
import type { Skill } from '../skills/skills.js';
import type { Message, Usage } from '../types.js';

// The slash commands that only print: this module writes the reply, a front end shows it.

export type ReplyCommandContext = {
  cwd: string | undefined;
  skills: Skill[];
  // The scrollback and the session's counters, for /tokens and /stats.
  messages: Message[];
  usage: Usage;
  startedAt: number;
  approvals: Approvals;
  // `/mcp`'s listing, or undefined where the session has no MCP manager.
  mcpList: () => string | undefined;
};

// The reply for a command that only prints, or null when `name` is not one of them.
export function resolveReplyCommand(name: string, ctx: ReplyCommandContext): string | null {
  switch (name) {
    case 'help':
      return helpText();
    case 'cwd':
      return ctx.cwd ?? '(unknown)';
    case 'tokens': {
      const approx = ctx.usage.estimated ? '~' : '';
      return `prompt:     ${approx}${ctx.usage.promptTokens}\ncompletion: ${approx}${ctx.usage.completionTokens}`;
    }
    case 'stats':
      return hasActivity(ctx.messages)
        ? buildSummary(ctx.messages, ctx.usage, ctx.startedAt, ctx.approvals)
        : 'No activity yet.';
    case 'skills':
      return skillsText(ctx.skills);
    case 'mcp':
      return ctx.mcpList() ?? 'MCP is not available in this session.';
    default:
      return null;
  }
}

export function unknownCommandText(name: string): string {
  return `Unknown command: /${name}. Try /help.`;
}

function skillsText(skills: Skill[]): string {
  if (skills.length === 0) {
    return 'No skills loaded. Drop *.md files or SKILL.md folders in ~/.config/reika/skills/, <cwd>/.reika/skills/, ~/.agents/skills/ or <cwd>/.agents/skills/.';
  }
  return [
    'Available skills (invoke as /<name>):',
    ...skills.map(
      s =>
        `  /${s.name.padEnd(16)} ${s.description} ${s.from ? `(${s.from})` : s.source === 'project' ? '(project)' : ''}`,
    ),
  ].join('\n');
}

// Every command in COMMANDS (ui/commands.ts) has a row here; App.render.test.tsx checks it.
export function helpText(): string {
  return [
    'Commands:',
    '  /help              show this list',
    '  /new, /clear       reset conversation, tokens, mode',
    '  /cd <path>         change cwd (re-indexes repo map)',
    '  /shell             enter shell mode (raw bash, no model)',
    '  /chat              enter chat mode (no filesystem/shell tools; isolated)',
    '  /plan              enter plan mode (read-only exploration; ends with a written plan)',
    '  /vibe              enter vibe mode (every prompt plans first, then implements)',
    '  /minimal           enter minimal mode (shell only, no upfront project context)',
    '  /grind             enter grind mode (verify-everything procedure; slower, checks its work)',
    '  /agent             return to agent mode',
    '  /implement         execute the plan above (from plan mode: pick the mode to run it in)',
    '  /compact           compact older context now (compaction note, then a fold)',
    '  /model [name]      pick a model/profile (interactive without a name; a name not in your config switches ad-hoc)',
    '  /anon              show/toggle anonymized display (on|off; bare command opens the picker)',
    '  /approvals         show/toggle session auto-approve (on|off; bare command opens the picker)',
    '  /unattended        show/toggle unattended: decline instead of prompting (on|off; bare command opens the picker)',
    '  /cwd               show working directory',
    '  /tokens            show token usage this session',
    '  /stats             show full session summary',
    '  /save              save the full conversation to history, even mid-turn (--raw skips redaction)',
    '  /resume [all|root] resume a saved session of this project (chat mode: chats only; all: every session; root: the /save files)',
    '  /skills            list available skills (loaded from your skill directories)',
    '  /mcp               list MCP servers and their tools (REIKA_MCP_SERVERS)',
    '  /<server>:<tool>   call an MCP tool directly (JSON args, or the bare string for a one-arg tool)',
    '  /search <query>    search the web: the model runs one search and answers from the results',
    '  /exit, /quit       exit reika (prints summary)',
    '  @<path>            in agent mode, inline a file as context',
    '  ctrl-v             paste an image; its text is read out and attached (macOS/Windows)',
    '  shift+tab          cycle mode (agent → plan → minimal → vibe → grind → chat → shell)',
  ].join('\n');
}

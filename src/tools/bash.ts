import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const OUTPUT_TAIL_BYTES = 2 * 1024;
const OUTPUT_TAIL_LINES = 10;

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Execute a shell command in the working directory. Prefer the dedicated tools (read, grep, edit, write, list) when they fit; use bash for build, test, lint, git, and similar workflows.',
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

    return execStream(command, ctx);
  },
};

export function execStream(
  command: string,
  ctx: { cwd: string; onProgress?: (chunk: string) => void },
): Promise<ToolResult> {
  return new Promise(resolve => {
    const proc = spawn('/bin/sh', ['-c', command], { cwd: ctx.cwd });
    const buffer: string[] = [];
    let totalBytes = 0;
    let timedOut = false;

    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      ctx.onProgress?.(text);
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
    }, DEFAULT_TIMEOUT_MS);

    proc.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      const rawOutput = buffer.join('');
      const truncated = totalBytes >= MAX_PAYLOAD_BYTES ? '\n…(truncated)' : '';
      const payload = rawOutput + truncated || '(no output)';
      const display = buildCommandDisplay(command, rawOutput);
      if (timedOut) {
        resolve({
          summary: `Bash timeout: ${command} (killed after ${DEFAULT_TIMEOUT_MS / 1000}s)`,
          payload,
          command: display,
        });
      } else if (code === 0) {
        resolve({
          summary: `Ran: ${command} (${totalBytes} bytes output)`,
          payload,
          command: display,
        });
      } else {
        const reason = signal ? `signal ${signal}` : `exit ${code}`;
        resolve({
          summary: `Bash failed: ${command} (${reason})`,
          payload,
          command: display,
        });
      }
    });

    proc.on('error', err => {
      clearTimeout(timeoutId);
      resolve({
        summary: `Bash failed: ${command} (${err.message})`,
        payload: buffer.join('') || err.message,
        command: buildCommandDisplay(command, buffer.join('') || err.message),
      });
    });
  });
}

function buildCommandDisplay(
  command: string,
  output: string,
): { text: string; outputTail: string; outputTruncated: boolean } {
  if (!output) return { text: command, outputTail: '', outputTruncated: false };
  const byteTail =
    output.length > OUTPUT_TAIL_BYTES ? output.slice(output.length - OUTPUT_TAIL_BYTES) : output;
  const lines = byteTail.split('\n');
  const lineTail = lines.slice(-OUTPUT_TAIL_LINES);
  const outputTruncated = output.length > byteTail.length || lines.length > OUTPUT_TAIL_LINES;
  return { text: command, outputTail: lineTail.join('\n'), outputTruncated };
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
  {
    re: /\bgem\s+install\b(?![^|;&]*--user\b)/,
    label: 'Gem install (system-level unless --user)',
  },
];

export function detectDangerousPatterns(command: string): string[] {
  const hits: string[] = [];
  for (const { re, label } of DANGER_PATTERNS) {
    if (re.test(command) && !hits.includes(label)) hits.push(label);
  }
  return hits;
}

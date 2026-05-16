import { spawn } from 'node:child_process';
import type { Tool, ToolResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export const bashTool: Tool = {
  name: 'bash',
  description: 'Execute a shell command in the working directory. Prefer the dedicated tools (read, grep, edit, write, list) when they fit; use bash for build, test, lint, git, and similar workflows.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute. Single string, run via /bin/sh.' },
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

function execStream(
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
      const truncated = totalBytes >= MAX_PAYLOAD_BYTES ? '\n…(truncated)' : '';
      const payload = (buffer.join('') + truncated) || '(no output)';
      if (timedOut) {
        resolve({
          summary: `Bash timeout: ${command} (killed after ${DEFAULT_TIMEOUT_MS / 1000}s)`,
          payload,
        });
      } else if (code === 0) {
        resolve({
          summary: `Ran: ${command} (${totalBytes} bytes output)`,
          payload,
        });
      } else {
        const reason = signal ? `signal ${signal}` : `exit ${code}`;
        resolve({
          summary: `Bash failed: ${command} (${reason})`,
          payload,
        });
      }
    });

    proc.on('error', err => {
      clearTimeout(timeoutId);
      resolve({
        summary: `Bash failed: ${command} (${err.message})`,
        payload: buffer.join('') || err.message,
      });
    });
  });
}

const DANGER_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, label: 'Recursive force delete (rm -rf)' },
  { re: /\bsudo\b/, label: 'Privilege escalation (sudo)' },
  { re: /(curl|wget)[^|]*\|\s*(sh|bash|zsh)\b/, label: 'Piping remote content to shell' },
  { re: /\|\s*(sh|bash|zsh)\b/, label: 'Piping to shell' },
  { re: /\bdd\s+[^&;|]*\bof=\/dev\//, label: 'Direct device write (dd of=/dev/…)' },
  { re: /\bgit\s+push[^&;|]*(--force\b|--force-with-lease\b|\s-f\b)/, label: 'Force push to remote' },
  { re: /\bgit\s+branch\s+-D\b/, label: 'Force-delete git branch' },
  { re: /\bgit\s+reset\s+--hard\b/, label: 'Hard reset (discards uncommitted changes)' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, label: 'Force-clean untracked files' },
  { re: /\bchmod\s+[0-7]*777\b/, label: 'Open permissions (chmod 777)' },
  { re: /\brm\s+[^&;|]*\.env\b/, label: 'Deleting environment file (.env)' },
  { re: />\s*\/dev\/sd[a-z]\b/, label: 'Writing to raw disk device' },
  { re: /:(){:|:&};:|:\(\)\s*\{\s*:\|:&\s*\};\s*:/, label: 'Fork bomb pattern' },
];

function detectDangerousPatterns(command: string): string[] {
  const hits: string[] = [];
  for (const { re, label } of DANGER_PATTERNS) {
    if (re.test(command)) hits.push(label);
  }
  return hits;
}

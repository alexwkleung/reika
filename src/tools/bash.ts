import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool } from '../types.js';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
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
      const ok = await ctx.requestApproval({
        tool: 'bash',
        subject: ctx.cwd,
        preview: command,
      });
      if (!ok) return { summary: `Bash declined by user: ${command}` };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.cwd,
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      const payload = combineOutput(stdout, stderr);
      return {
        summary: `Ran: ${command} (${payload.length} bytes output)`,
        payload: payload.length > 0 ? payload : '(no output)',
      };
    } catch (e) {
      const err = e as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };
      const payload = combineOutput(err.stdout ?? '', err.stderr ?? '');
      const exitInfo =
        err.signal ? `signal ${err.signal}` :
        err.code !== undefined ? `exit ${err.code}` :
        err.message;
      return {
        summary: `Bash failed: ${command} (${exitInfo})`,
        payload: payload || err.message,
      };
    }
  },
};

function combineOutput(stdout: string, stderr: string): string {
  let out = stdout + (stderr ? `\n${stderr}` : '');
  if (out.length > MAX_PAYLOAD_BYTES) {
    out = out.slice(0, MAX_PAYLOAD_BYTES) + `\n…(truncated, ${out.length - MAX_PAYLOAD_BYTES} more bytes)`;
  }
  return out;
}

import { describe, expect, it } from 'vitest';
import {
  MAX_HELD_SHELL_RUNS,
  SHELL_RUN_MAX_CHARS,
  SHELL_RUN_MIN_CHARS,
  buildShellRunsBlock,
  holdShellRun,
  shellRunBudget,
  type ShellRun,
} from './shellruns.js';

const run = (command: string, output: string, exitCode: number | null = 0): ShellRun => ({
  command,
  exitCode,
  output,
});

const lines = (n: number, prefix = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n');

describe('shellRunBudget', () => {
  it('uses the floor when no window is known', () => {
    expect(shellRunBudget()).toEqual({
      perRun: SHELL_RUN_MIN_CHARS,
      total: SHELL_RUN_MIN_CHARS * 2,
    });
  });

  it('scales with the window between the floor and the cap', () => {
    expect(shellRunBudget(16_000).perRun).toBe(SHELL_RUN_MIN_CHARS);
    expect(shellRunBudget(32_000).perRun).toBe(2000);
    expect(shellRunBudget(1_000_000).perRun).toBe(SHELL_RUN_MAX_CHARS);
  });
});

describe('holdShellRun', () => {
  it('drops the oldest past the cap', () => {
    let held: ShellRun[] = [];
    for (let i = 0; i < MAX_HELD_SHELL_RUNS + 3; i++)
      held = holdShellRun(held, run(`cmd ${i}`, ''));
    expect(held).toHaveLength(MAX_HELD_SHELL_RUNS);
    expect(held[0].command).toBe('cmd 3');
  });
});

describe('buildShellRunsBlock', () => {
  const budget = shellRunBudget();

  it('is empty with nothing held', () => {
    expect(buildShellRunsBlock([], budget)).toBe('');
  });

  it('carries the command, exit status and short output whole', () => {
    const block = buildShellRunsBlock([run('pnpm test', 'FAIL a.test.ts', 1)], budget);
    expect(block).toContain('$ pnpm test  (exit 1)');
    expect(block).toContain('FAIL a.test.ts');
    expect(block).toContain('context, not a request');
    expect(block).not.toContain('omitted');
  });

  it('keeps the end of long output, cut at a line boundary', () => {
    const output = lines(400);
    const block = buildShellRunsBlock([run('pnpm test', output, 1)], budget);
    expect(block).toContain('line 400');
    expect(block).not.toContain('line 1\n');
    expect(block).toContain('…(earlier output omitted)');
    const tail = block.split('…(earlier output omitted)\n')[1];
    expect(tail.startsWith('line ')).toBe(true);
    expect(block.length).toBeLessThan(budget.perRun + 300);
  });

  it('names the saved file when the output was cut', () => {
    const r = {
      ...run('pnpm test', lines(400), 1),
      spill: { path: '/tmp/reika-abc123/shell-1.txt', bytes: 1 },
    };
    expect(buildShellRunsBlock([r], budget)).toContain(
      'full output saved to /tmp/reika-abc123/shell-1.txt',
    );
  });

  it('gives the newest run the budget and keeps older command lines', () => {
    const runs = [
      run('old one', lines(400, 'old')),
      run('mid one', lines(400, 'mid')),
      run('new one', lines(400, 'new')),
    ];
    const block = buildShellRunsBlock(runs, budget);
    expect(block).toContain('new 400');
    expect(block).toContain('mid 400');
    expect(block).toContain('$ old one  (exit 0)');
    expect(block).not.toContain('old 400');
    expect(block).toMatch(/\$ old one {2}\(exit 0\)\n\(\d+ chars of output omitted\)/);
    expect(block.length).toBeLessThan(budget.total + 600);
  });

  it('says when a run printed nothing or was killed', () => {
    const block = buildShellRunsBlock([run('true', ''), run('sleep 99', '', null)], budget);
    expect(block).toContain('$ true  (exit 0)\n(no output)');
    expect(block).toContain('$ sleep 99  (killed)');
  });
});

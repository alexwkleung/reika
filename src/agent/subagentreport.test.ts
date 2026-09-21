import { describe, expect, it } from 'vitest';
import type { Message } from '../types.js';
import {
  SUBAGENT_REPORT_DIRECTIVE,
  buildCoverageNote,
  extractTaskPaths,
  readPathsIn,
} from './subagentreport.js';

// The task string a qwen3.8-27b parent actually wrote in the #273 arm-2 run: bare paths in prose,
// some in parentheses, one followed by a colon. Nothing backticked.
const ARM2_TASK = `Trace the approval path for a bash tool call in this repo (TypeScript, Ink UI, agent loop). I need every file + function in the chain, in order.

1. In src/tools/bash.ts (and any helpers it uses, e.g. src/tools/_readonly.ts, src/tools/_paths.ts, src/tools/_diff.ts): how does the bash tool decide it needs approval?
2. In src/types.ts: the shapes of ApprovalRequest, ToolContext, AutoApproveMode.
3. In src/ui/App.tsx (and any other UI file like src/ui/Status.tsx): where does the UI create requestApproval?
4. In src/agent/loop.ts (or wherever tool calls are executed): how is the ToolContext constructed per call?
5. Also check src/config.ts for how AutoApproveMode is resolved, and grep for usages of requestApproval across src/.`;

const read = (path: string, id = 'r'): Message => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id, name: 'read', args: { path } }],
});

describe('extractTaskPaths', () => {
  it('finds bare paths in prose, in order, deduped', () => {
    expect(extractTaskPaths(ARM2_TASK)).toEqual([
      'src/tools/bash.ts',
      'src/tools/_readonly.ts',
      'src/tools/_paths.ts',
      'src/tools/_diff.ts',
      'src/types.ts',
      'src/ui/App.tsx',
      'src/ui/Status.tsx',
      'src/agent/loop.ts',
      'src/config.ts',
    ]);
  });

  it('takes backticked and ./-prefixed forms too', () => {
    expect(extractTaskPaths('Read `src/a.ts` and ./lib/b.js then report.')).toEqual([
      'src/a.ts',
      'lib/b.js',
    ]);
  });

  // A bare directory ("src/") or a symbol ("foo.bar") is not a file the subagent could have read.
  it('ignores directories, dotted symbols, and bare names', () => {
    expect(extractTaskPaths('grep across src/ for config.autoApprove and bash')).toEqual([]);
  });
});

describe('readPathsIn', () => {
  it('collects read targets only — grep and glob hits are not reads', () => {
    const history: Message[] = [
      read('src/tools/bash.ts'),
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'g', name: 'grep', args: { pattern: 'x', path: 'src/ui/App.tsx' } },
          { id: 'r2', name: 'read', args: { path: './src/types.ts' } },
        ],
      },
      { role: 'tool', callId: 'r', summary: 'Read src/tools/bash.ts', payload: '' },
    ];
    expect([...readPathsIn(history)]).toEqual(['src/tools/bash.ts', 'src/types.ts']);
  });
});

describe('buildCoverageNote', () => {
  it('names what the task listed that the subagent never opened', () => {
    const note = buildCoverageNote(ARM2_TASK, [
      read('src/tools/bash.ts'),
      read('src/tools/_readonly.ts'),
      read('src/tools/_paths.ts'),
      read('src/types.ts'),
      read('src/tools/_danger.ts'),
      read('src/config.ts'),
    ]);
    expect(note).toContain('the task named 9 files');
    expect(note).toContain(
      'did not read src/tools/_diff.ts, src/ui/App.tsx, src/ui/Status.tsx, src/agent/loop.ts',
    );
    expect(note).toContain('read src/tools/bash.ts, src/tools/_readonly.ts');
    expect(note).toContain('hand them to subagent again');
  });

  it('is empty when everything named was read', () => {
    expect(
      buildCoverageNote('Look at src/a.ts and src/b.ts.', [read('src/a.ts'), read('src/b.ts')]),
    ).toBe('');
  });

  it('is empty when the task names no files — nothing to check against', () => {
    expect(buildCoverageNote('Find where approval is decided and report the chain.', [])).toBe('');
  });

  // The task says `tools/bash.ts`, the model reads `src/tools/bash.ts` (or the reverse).
  it('matches a task path against a read path by suffix either way', () => {
    expect(buildCoverageNote('See tools/bash.ts.', [read('src/tools/bash.ts')])).toBe('');
    expect(buildCoverageNote('See src/tools/bash.ts.', [read('tools/bash.ts')])).toBe('');
    expect(buildCoverageNote('See src/tools/bash.ts.', [read('src/tools/_bash.ts')])).toContain(
      'did not read src/tools/bash.ts',
    );
  });
});

describe('SUBAGENT_REPORT_DIRECTIVE', () => {
  it('asks for file and function names and a "Not covered" list, and forbids continuing', () => {
    expect(SUBAGENT_REPORT_DIRECTIVE).toContain('tools are withdrawn');
    expect(SUBAGENT_REPORT_DIRECTIVE).toContain('file and function names');
    expect(SUBAGENT_REPORT_DIRECTIVE).toContain('"Not covered:"');
    expect(SUBAGENT_REPORT_DIRECTIVE).toContain('do not ask to continue');
  });
});

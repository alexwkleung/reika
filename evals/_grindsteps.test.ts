import { describe, expect, it } from 'vitest';
import type { Message } from '../src/types.js';
import { formatGrindSteps, scoreGrindSteps } from './_grindsteps.js';

let id = 0;
const call = (name: string, args: Record<string, unknown>, content = ''): Message => ({
  role: 'assistant',
  content,
  toolCalls: [{ id: `c${id++}`, name, args }],
});
const bash = (command: string) => call('bash', { command });
const reply = (content: string): Message => ({ role: 'assistant', content });

describe('scoreGrindSteps', () => {
  it('credits every step of a full grind run', () => {
    const messages: Message[] = [
      call(
        'read',
        { path: 'src/chunk.js' },
        'Done means chunk() rejects sizes that cannot progress.',
      ),
      call('edit', { path: 'src/chunk.js', old_string: 'a', new_string: 'b' }),
      bash('npm test'),
      bash(`node -e "import('./src/chunk.js').then(m => m.chunk([1], 0))"`),
      bash('git diff'),
      reply('Verified by running the suite and a NaN/0 check. Not verified: very large arrays.'),
    ];
    const s = scoreGrindSteps(messages, 'src/chunk.js');
    expect(Object.values(s).every(Boolean)).toBe(true);
    expect(formatGrindSteps(s)).toBe('steps 1·2·5a·5b·6·7 (6/6)');
  });

  it('counts only checks made after the change', () => {
    const messages: Message[] = [
      bash('npm test'),
      bash('git diff'),
      call('edit', { path: 'src/chunk.js', old_string: 'a', new_string: 'b' }),
      reply('Done.'),
    ];
    const s = scoreGrindSteps(messages, 'src/chunk.js');
    expect(s.tested).toBe(false);
    expect(s.reviewedDiff).toBe(false);
    expect(s.pinned).toBe(false);
    expect(s.reported).toBe(false);
  });

  it('treats a shell write as the change, for minimal mode', () => {
    const messages: Message[] = [
      bash('cat src/chunk.js'),
      bash("sed -i '' 's/a/b/' src/chunk.js"),
      bash('node --test'),
    ];
    const s = scoreGrindSteps(messages, 'src/chunk.js');
    expect(s.explored).toBe(true);
    expect(s.tested).toBe(true);
    // The test runner itself is not an edge-case check of the model's own.
    expect(s.edgeChecked).toBe(false);
  });

  it('does not mistake a read with a stderr redirect for the change', () => {
    const messages: Message[] = [
      bash('ls -la src/ 2>/dev/null && cat src/chunk.js 2>/dev/null'),
      bash("cat > src/chunk.js <<'EOF'\nexport const x = 1;\nEOF"),
      bash('npm test 2>&1 | tail -20'),
    ];
    const s = scoreGrindSteps(messages, 'src/chunk.js');
    expect(s.explored).toBe(true);
    expect(s.tested).toBe(true);
  });

  it('scores nothing after the change when there was none', () => {
    const s = scoreGrindSteps([bash('npm test'), reply('Looks fine.')], 'src/chunk.js');
    expect(s.tested).toBe(false);
    expect(formatGrindSteps(s)).toBe('steps -·-·-·-·-·- (0/6)');
  });
});

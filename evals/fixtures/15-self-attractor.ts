import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fixture } from '../types.js';
import { DOCS_DIR } from '../../src/version.js';

// The other half of #531: does naming reika's paths pull a model into them on a task that never
// mentions reika? The prompt line is scoped "only if the user asks about reika itself" for exactly
// this — on a small model a named path is an attractor — and this fixture is where that framing is
// graded. The task says "config" on purpose, the word most likely to send a model to
// `~/.config/reika`. Passes only on the right answer reached without touching reika's own files.
export const fixture: Fixture = {
  name: 'self-attractor',
  setup: {
    'config/default.json': JSON.stringify({ server: { port: 4180, host: '0.0.0.0' } }, null, 2),
    'src/config.ts': [
      "import defaults from '../config/default.json';",
      '',
      'export const port = Number(process.env.PORT ?? defaults.server.port);',
      '',
    ].join('\n'),
    'README.md': '# scratch service\n',
  },
  prompt:
    'Where does this project load its config from, and what port does it listen on by default?',
  timeoutMs: 6 * 60 * 1000,
  assert: ({ messages }) => {
    const reikaPaths = [join(homedir(), '.config', 'reika'), '~/.config/reika'];
    if (DOCS_DIR) reikaPaths.push(DOCS_DIR);
    const calls = messages.flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
    const strayed = calls.filter(c =>
      Object.values(c.args).some(v => typeof v === 'string' && reikaPaths.some(p => v.includes(p))),
    );
    if (strayed.length > 0) {
      return {
        pass: false,
        reason: `wandered into reika's own files: ${strayed.map(c => JSON.stringify(c.args)).join(' | ')}`,
      };
    }
    const answer = messages
      .flatMap(m => (m.role === 'assistant' && m.content ? [m.content] : []))
      .join('\n');
    if (!/4180/.test(answer))
      return { pass: false, reason: 'stayed in the repo but missed the port' };
    return { pass: true, note: `${calls.length} tool calls` };
  },
};

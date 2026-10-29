import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fixture } from '../types.js';
import type { Message } from '../../src/types.js';
import { serializeSession } from '../../src/store/sessions.js';
import { renderTxt, serializeJsonl, TRANSCRIPT_VERSION } from '../../src/store/transcript.js';

// Does a model asked about its past reika sessions find the auto-saved ones? They live under
// `~/.config/reika/history/projects/<name>-<hash>/`, while the history root holds only `/save`
// transcripts and pre-auto-save sessions — so a model that lists the root sees a page of `.jsonl`
// and has no reason to look further. Uptake, so 3+ runs per arm; the baseline arm is the self line
// that named `history/` alone (main before #865), not `REIKA_SELF_AWARE=0`.
//
// The newest session is in `projects/`, and the root's newest is a different, distinctive task, so
// the answer says which directory the model stopped in.

const NEWEST_PROJECT_TASK = 'Migrate the settings page state from Redux to Zustand';
const NEWEST_ROOT_TASK = 'Add CSV export to the reports table';

function session(task: string, reply: string): Message[] {
  return [
    { role: 'user', content: task },
    { role: 'assistant', content: reply },
  ];
}

function meta(savedAt: string, cwd: string, messages: Message[]) {
  return {
    version: TRANSCRIPT_VERSION,
    savedAt,
    model: 'local-model',
    baseURL: 'http://localhost:8080/v1',
    cwd,
    messageCount: messages.length,
    mode: 'agent' as const,
  };
}

function stem(savedAt: string, id: string): string {
  return `${savedAt.replace(/[:.]/g, '-')}-${id}`;
}

const HISTORY = '.config/reika/history';
const home: NonNullable<Fixture['home']> = {};

const rootSaves: [string, string, string, string][] = [
  [
    '2026-09-02T17:11:40.120Z',
    'a1b2c3',
    'Rename the logger module to log',
    'Renamed and updated 6 imports.',
  ],
  [
    '2026-09-09T21:03:05.512Z',
    'd4e5f6',
    'Fix the flaky date test in utils',
    'Pinned the clock with a fake timer.',
  ],
  [
    '2026-09-15T15:47:22.908Z',
    '0a9b8c',
    NEWEST_ROOT_TASK,
    'Added an Export CSV button and a serializer.',
  ],
];
for (const [savedAt, id, task, reply] of rootSaves) {
  const messages = session(task, reply);
  const m = meta(savedAt, '/repo/webapp', messages);
  home[`${HISTORY}/${stem(savedAt, id)}.jsonl`] = {
    content: serializeJsonl(messages, m),
    mtime: savedAt,
  };
  home[`${HISTORY}/${stem(savedAt, id)}.txt`] = { content: renderTxt(messages, m), mtime: savedAt };
}

const autosaves: [string, string, string, string, string, string][] = [
  [
    'webapp-3f1a9c2e',
    '/repo/webapp',
    '2026-10-20T19:22:13.004Z',
    '7c6d5e',
    'Add retry with backoff to the webhook sender',
    'Retries 3 times with exponential backoff.',
  ],
  [
    'docs-site-8e2b4d70',
    '/repo/docs-site',
    '2026-10-24T10:05:51.377Z',
    '4f3e2d',
    'Fix the broken sidebar links in the docs',
    'Fixed 4 links after the guide/ rename.',
  ],
  [
    'webapp-3f1a9c2e',
    '/repo/webapp',
    '2026-10-27T18:40:09.861Z',
    '1b2c3d',
    NEWEST_PROJECT_TASK,
    'Moved the settings slice to a Zustand store; two selectors left to port.',
  ],
];
for (const [dir, cwd, savedAt, id, task, reply] of autosaves) {
  const messages = session(task, reply);
  home[`${HISTORY}/projects/${dir}/${stem(savedAt, id)}.jsonl`] = {
    content: serializeSession({ agent: messages, chat: [] }, meta(savedAt, cwd, messages)),
    mtime: savedAt,
  };
}

export const fixture: Fixture = {
  name: 'self-history',
  setup: { 'README.md': '# scratch project\n\nA placeholder repo.\n' },
  home,
  prompt: 'What was I working on in my most recent reika session?',
  timeoutMs: 10 * 60 * 1000,
  assert: ({ messages, home: homeDir }) => {
    const calls = messages.flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []) : []));
    const args = calls.flatMap(c => Object.values(c.args).filter(v => typeof v === 'string'));
    const historyRoots = ['~/.config/reika/history', ...(homeDir ? [`${homeDir}/${HISTORY}`] : [])];
    const lookedInHistory = args.some(a => historyRoots.some(r => a.includes(r)));
    const namedProjects = args.some(a => a.includes('/history/projects'));
    const answer = messages
      .flatMap(m => (m.role === 'assistant' && m.content ? [m.content] : []))
      .join('\n');
    const route = `${calls.length} tool calls, ${namedProjects ? 'named' : 'never named'} projects/`;

    // Reads are not confined, and the prompt's docs path names the real home directory, so a model
    // can reach the developer's actual history by absolute path (observed once). HOME is restored
    // by the time this runs, so homedir() is the real one.
    const realHistory = join(homedir(), HISTORY);
    if (args.some(a => a.includes(realHistory))) {
      return {
        pass: false,
        reason: `invalid run: escaped the fake HOME to ${realHistory} by absolute path (${route})`,
      };
    }
    if (/zustand/i.test(answer)) return { pass: true, note: route };
    if (/csv/i.test(answer)) {
      return {
        pass: false,
        reason: `stopped at the history root: answered with its newest /save transcript (${route})`,
      };
    }
    if (!lookedInHistory) {
      return {
        pass: false,
        reason: `never looked in ~/.config/reika/history; tool calls: ${calls.map(c => c.name).join(', ') || '(none)'}`,
      };
    }
    return { pass: false, reason: `looked in history but named neither newest task (${route})` };
  },
};

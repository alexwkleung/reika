import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { Scrollback } from './Scrollback.js';
import { Approval } from './Approval.js';
import { Question } from './Question.js';
import { Confirm } from './Confirm.js';
import { QueuedList } from './QueuedList.js';
import { PlanProgress } from './PlanProgress.js';
import { clearIdentity, setIdentity } from './identity.js';
import type { Message } from '../types.js';

// #1015: the TUI surfaces that used to draw unscrubbed.
const home = homedir();
const deep = `${home}/elsewhere/notes.md`;

const frame = (el: React.ReactElement): string => stripAnsi(render(el).lastFrame() ?? '');

const scrollback = (messages: Message[], live: Partial<Record<string, string>> = {}) =>
  frame(
    <Scrollback
      messages={messages}
      streaming={live.content ?? ''}
      streamingReasoning={live.reasoning ?? ''}
      streamingTool={live.tool ?? ''}
    />,
  );

afterEach(() => clearIdentity());

describe('display scrub on the surfaces #1015 names', () => {
  it('assistant prose and reasoning collapse $HOME', () => {
    const out = scrollback([
      { role: 'assistant', content: `See ${deep} for it.`, reasoning: `Reading ${deep} first.` },
    ]);
    expect(out).not.toContain(home);
    expect(out).toContain('~/elsewhere/notes.md');
  });

  it('/anon replaces the name in assistant prose', () => {
    setIdentity({ names: ['octocat'], emails: [] });
    const out = scrollback([{ role: 'assistant', content: 'Thanks, octocat.' }]);
    expect(out).not.toContain('octocat');
    expect(out).toContain('<user>');
  });

  it('live content holds a path that has not finished arriving', () => {
    const partial = home.slice(0, -2);
    const out = scrollback([], { content: `Opening ${partial}` });
    expect(out).toContain('Opening');
    expect(out).not.toContain(partial);
  });

  it('a diff draws its lines scrubbed', () => {
    const out = scrollback([
      {
        role: 'tool',
        callId: 'c1',
        name: 'edit',
        summary: 'Edited notes.md',
        diff: { text: `+ link: ${deep}`, path: deep, added: 1, removed: 0 },
      } as Message,
    ]);
    expect(out).not.toContain(home);
    expect(out).toContain('~/elsewhere/notes.md');
  });

  it('an approval scrubs its subject and preview paths but keeps a secret visible', () => {
    const out = frame(
      <Approval
        request={{
          tool: 'bash',
          subject: `cat ${deep}`,
          preview: `notarytool --apple-id me@example.net ${deep}`,
        }}
        selectedIndex={0}
        width={100}
        rows={40}
      />,
    );
    expect(out).not.toContain(home);
    expect(out).toContain('me@example.net');
  });

  it('question, confirm, queue and plan steps collapse $HOME', () => {
    const outs = [
      frame(
        <Question
          request={{ question: `Move ${deep}?`, options: [{ label: `Into ${deep}` }] }}
          selectedIndex={0}
          width={100}
          rows={40}
        />,
      ),
      frame(
        <Confirm
          spec={{ title: 'Fetch', subtitle: deep, details: [deep], options: ['No', 'Yes'] }}
          selectedIndex={0}
        />,
      ),
      frame(<QueuedList queue={[{ content: `then ${deep}`, answers: {} }]} />),
      frame(
        <PlanProgress
          steps={[
            {
              n: 1,
              text: `Edit ${deep}`,
              paths: [],
              snippets: [],
              commands: [],
              done: false,
              waived: false,
            },
          ]}
        />,
      ),
    ];
    for (const out of outs) {
      expect(out).not.toContain(home);
      expect(out).toContain('~/elsewhere');
    }
  });
});

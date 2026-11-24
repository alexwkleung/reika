import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WireMessage } from '../protocol.js';
import { MessageRow } from './MessageRow.js';
import { Transcript } from './Transcript.js';

const row = (message: WireMessage, opts: { gap?: boolean; groupedReads?: boolean } = {}) =>
  renderToStaticMarkup(
    <MessageRow message={message} gap={!!opts.gap} groupedReads={!!opts.groupedReads} />,
  );

const transcript = (messages: WireMessage[], idle = true) =>
  renderToStaticMarkup(<Transcript messages={messages} idle={idle} />);

// Text as a reader sees it, tags dropped and entities decoded.
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');

describe('user rows', () => {
  it('draws the display text over the content, with the rule as the row border', () => {
    const html = row({ role: 'user', content: 'expanded body', display: '/review 12' });
    expect(html).toContain('class="row row-user"');
    expect(html).not.toContain('▎');
    expect(text(html)).toContain('/review 12');
    expect(text(html)).not.toContain('expanded body');
  });

  it('marks a subagent task and a command echo', () => {
    const nested = row({ role: 'user', content: 'look at a.ts', nested: true });
    expect(nested).toContain('row-user--nested');
    expect(text(nested)).toContain('Subagent task:');
    expect(row({ role: 'user', content: '/stats', meta: true })).toContain('row-user--meta');
  });
});

describe('assistant rows', () => {
  it('draws reasoning, prose as markdown, calls and sources in order', () => {
    const html = row({
      role: 'assistant',
      reasoning: 'first\n\n\nsecond',
      content: 'Use **bold** here.',
      toolCalls: [
        { id: 'c1', name: 'read', args: { path: 'src/a.ts' } },
        { id: 'c2', name: 'edit', args: { path: 'b.ts', old_string: 'x', new_string: 'y' } },
        { id: 'c3', name: 'ask_user', args: { question: 'ok?' } },
      ],
      sources: ['https://example.com/a'],
    });
    const t = text(html);
    expect(t.indexOf('Thinking')).toBeLessThan(t.indexOf('Use bold here.'));
    expect(html).toContain('<p>first</p><p>second</p>');
    expect(html).toContain('<strong>bold</strong>');
    // The label in words and the path it acts on as code (toolparts.ts).
    expect(html).toContain(
      '<span class="call-name">Read</span><span class="call-args"><code class="tool-literal">src/a.ts</code></span>',
    );
    // An edit's strings are shown by its diff, so the call row hides them.
    expect(t).toContain('⏺Editb.ts');
    expect(t).not.toContain('old_string');
    // A tool with no literal of its own keeps its arguments, muted.
    expect(html).toContain('<span class="tool-detail">question=&quot;ok?&quot;</span>');
    expect(t.indexOf('Editb.ts')).toBeLessThan(t.indexOf('Sources: https://example.com/a'));
  });

  it('shows long reasoning in its window, the whole of it behind a details element', () => {
    const html = row({ role: 'assistant', reasoning: 'a\nb\nc\nd\ne\nf\ng\nh\ni', content: '' });
    expect(html).toContain('<details class="reasoning-details">');
    expect(html).toContain('9 lines');
    // The window holds the whole thought; CSS keeps its last rows in view.
    expect(html).toMatch(
      /reasoning-tail"><div class="reasoning-text"><div class="reasoning-md">.*a\nb\nc\nd\ne\nf\ng\nh\ni/s,
    );
    const short = row({ role: 'assistant', reasoning: 'one line', content: 'x' });
    expect(short).not.toContain('<details');
  });

  it('carries a thought the endpoint cut into content back into Thinking', () => {
    const html = row({ role: 'assistant', reasoning: 'quoting `--reasoning', content: '` flag.' });
    expect(html).toContain('quoting <code class="md-inline-code">--reasoning</code> flag.');
    expect(html).not.toContain('class="prose"');
  });

  it('cuts plan prose at planChecks.at and draws the checks', () => {
    const plan = '1. Edit `a.ts`.\n';
    const html = row({
      role: 'assistant',
      content: plan + '\n[reika grounding note]',
      planChecks: {
        at: plan.length,
        missing: ['fooBar'],
        deadUrls: [{ url: 'https://example.net/x', error: '404' }],
      },
    });
    const t = text(html);
    expect(t).not.toContain('grounding note');
    expect(t).toContain('Plan check');
    expect(t).toContain('1 reference not found in the codebase:');
    expect(t).toContain('fooBar');
    expect(t).toContain('1 link did not resolve:');
  });

  it('draws a compaction note as one info-barred block', () => {
    const html = row({
      role: 'assistant',
      content: 'Established: x',
      reasoning: 'thinking',
      compactionNote: true,
    });
    expect(html).toContain('class="note"');
    expect(html).toContain('reasoning--info');
    expect(text(html)).toContain('Compaction note');
    expect(html).not.toContain('class="prose"');
  });

  it('draws a discarded stream muted, and a discarded note as a note', () => {
    const stream = row({ role: 'assistant', content: 'half a reply', discarded: 'stream' });
    expect(stream).toContain('row-frozen');
    expect(text(stream)).toContain('half a reply');
    const note = row({ role: 'assistant', content: 'n', discarded: 'note' });
    expect(note).toContain('row-frozen');
    expect(note).toContain('class="note"');
  });

  it('closes a subagent block with its own Worked line', () => {
    const html = row({ role: 'assistant', content: 'done', durationMs: 4000, nested: true });
    expect(text(html)).toContain('Worked for 4s');
    expect(row({ role: 'assistant', content: 'done', durationMs: 4000 })).not.toContain('Worked');
  });
});

describe('tool rows', () => {
  it('draws the summary under the result marker, eliding a lone read verb', () => {
    const lone = row({ role: 'tool', callId: 'c', summary: 'Read src/a.ts lines 1-9 of 9' });
    expect(text(lone)).toBe('↳src/a.ts lines 1-9 of 9');
    expect(lone).toContain('row row-tool');
    const grouped = row(
      { role: 'tool', callId: 'c', summary: 'Read src/a.ts lines 1-9 of 9' },
      { groupedReads: true },
    );
    expect(text(grouped)).toBe('↳Read src/a.ts lines 1-9 of 9');
  });

  it('times a command result past five seconds only', () => {
    const cmd = { text: 'npm test', outputTail: 'ok', outputTruncated: false };
    const slow = row({
      role: 'tool',
      callId: 'c',
      summary: 'Ran: npm test',
      command: cmd,
      durationMs: 12000,
    });
    expect(text(slow)).toContain('Ran: npm test · 12s');
    const fast = row({
      role: 'tool',
      callId: 'c',
      summary: 'Ran: ls',
      command: cmd,
      durationMs: 3000,
    });
    expect(text(fast)).not.toContain('·');
    const read = row({ role: 'tool', callId: 'c', summary: 'Read a.ts', durationMs: 9000 });
    expect(text(read)).not.toContain('·');
  });

  it('draws the command chip with the omission marker above the tail', () => {
    const html = row({
      role: 'tool',
      callId: 'c',
      summary: 'Ran: npm test',
      command: { text: 'npm test', outputTail: 'line 99\nline 100', outputTruncated: true },
    });
    const t = text(html);
    expect(t).toContain('$Command: npm test');
    expect(t.indexOf('…(earlier output omitted)')).toBeLessThan(t.indexOf('line 99'));
  });

  it('draws a diff with line numbers', () => {
    const html = row({
      role: 'tool',
      callId: 'c',
      summary: 'Edited a.ts (+1 -1)',
      diff: { text: '  keep\n- old\n+ new', path: 'a.ts', added: 1, removed: 1, startLine: 10 },
    });
    expect(html).toContain('diff-row--removed');
    expect(html).toContain('diff-row--added');
    expect(html).toMatch(/diff-lineno">10<.*diff-lineno">11<.*diff-lineno">11</s);
  });

  it('marks the changed words of a paired line and colours the rest by the path', () => {
    const html = row({
      role: 'tool',
      callId: 'c',
      summary: 'Edited a.ts (+1 -1)',
      diff: {
        text: '- const x = foo(a, b);\n+ const x = bar(a, c);',
        path: 'a.ts',
        added: 1,
        removed: 1,
      },
    });
    expect(html).toContain('<span class="diff-word">foo</span>');
    expect(html).toContain('<span class="diff-word">bar</span>');
    expect(html).toContain('hljs-keyword');
  });

  it('draws a pair too different to compare as two plain coloured lines', () => {
    const html = row({
      role: 'tool',
      callId: 'c',
      summary: 'Edited a.txt (+1 -1)',
      diff: {
        text: '- alpha beta gamma\n+ one two three four',
        path: 'a.txt',
        added: 1,
        removed: 1,
      },
    });
    expect(html).not.toContain('diff-word');
  });

  it('draws changed files with their labels, hunks and remainders', () => {
    const html = row({
      role: 'tool',
      callId: 'c',
      summary: 'Ran: sed -i s/a/b/ x.ts',
      changes: {
        files: [
          {
            path: 'x.ts',
            kind: 'modified',
            added: 1,
            removed: 1,
            hunks: [{ text: '- a\n+ b', startLine: 3, oldStartLine: 3 }],
            omitted: 4,
          },
          { path: 'y.bin', kind: 'binary', added: 0, removed: 0, hunks: [] },
        ],
        more: 2,
      },
    } as WireMessage);
    const t = text(html);
    expect(t).toContain('x.ts (+1 -1)');
    expect(t).toContain('…(4 more lines)');
    expect(t).toContain('y.bin (binary)');
    expect(t).toContain('…2 more files changed');
  });
});

describe('notices, errors, shell and the rest', () => {
  it('a warn notice takes the recycle marker and tints its lead', () => {
    const html = row({
      role: 'system',
      content: 'Not sandboxed: the profile failed',
      tone: 'warn',
    });
    expect(html).toContain('row-system--warn');
    expect(text(html)).toContain('⟳');
    expect(html).toContain('<span class="row-system-lead">Not sandboxed:</span>');
  });

  it('info and default notices take the caret; emphasis line tints the whole row', () => {
    expect(row({ role: 'system', content: 'Folded', tone: 'info' })).toContain('row-system--info');
    const def = row({ role: 'system', content: 'Agent mode.' });
    expect(def).toContain('row-system--default');
    expect(text(def)).toContain('❯');
    expect(def).not.toContain('row-system-lead');
    expect(row({ role: 'system', content: 'x', emphasis: 'line' })).toContain('row-system--line');
  });

  it('draws a line of only ─ as a rule, keeping the text around it', () => {
    const html = row({
      role: 'system',
      content: `Session summary\n${'─'.repeat(40)}\nDuration: 5s`,
    });
    expect(html).toContain('<span class="row-system-rule" role="separator"></span>');
    expect(html).not.toContain('─');
    expect(text(html)).toContain('Session summary');
    expect(text(html)).toContain('Duration: 5s');
    expect(row({ role: 'system', content: 'a ── b' })).not.toContain('row-system-rule');
  });

  it('an error is labelled, and stays plain text', () => {
    const html = row({ role: 'error', content: '{"error":"*bad*"}' });
    expect(text(html)).toContain('Error: {"error":"*bad*"}');
    expect(html).not.toContain('<em>');
  });

  it('a shell run shows the command and its trimmed output', () => {
    const html = row({ role: 'shell', command: 'ls', output: 'a\nb\n\n' });
    // Tags dropped: the prompt, the command, then the output block.
    expect(text(html)).toBe('$lsa\nb');
  });

  it('a compaction message draws nothing and an unknown role a muted dump', () => {
    expect(row({ role: 'compaction', content: 'x' })).toBe('');
    const html = row({ role: 'header', x: 1 } as unknown as WireMessage);
    expect(html).toContain('row-unknown');
    expect(text(html)).toContain('"role":"header"');
  });
});

describe('the transcript', () => {
  const callRound: WireMessage = {
    role: 'assistant',
    content: '',
    toolCalls: [
      { id: 'r1', name: 'read', args: { path: 'a.ts' } },
      { id: 'r2', name: 'read', args: { path: 'b.ts' } },
    ],
  };

  it('draws a subagent’s run of rows as one nested block', () => {
    const html = transcript([
      { role: 'user', content: 'go' },
      { role: 'user', content: 'look at a.ts', nested: true },
      { role: 'assistant', content: '', reasoning: 'reading', nested: true, toolCalls: [] },
      { role: 'tool', callId: 'c', summary: 'Read a.ts lines 1-9 of 9', nested: true },
      { role: 'assistant', content: 'done', nested: true, durationMs: 4000 },
      { role: 'tool', callId: 's', summary: 'Subagent completed (10 chars)' },
    ]);
    expect(html.match(/class="nest"/g)).toHaveLength(1);
    const block = html.slice(html.indexOf('class="nest"'));
    expect(text(block.slice(0, block.indexOf('Subagent completed')))).toContain('Worked for 4s');
  });

  it('keeps the read verb on every row of a multi-read round', () => {
    const t = text(
      transcript([
        callRound,
        { role: 'tool', callId: 'r1', summary: 'Read a.ts lines 1-2 of 2' },
        { role: 'tool', callId: 'r2', summary: 'Read b.ts lines 1-2 of 2' },
      ]),
    );
    expect(t).toContain('↳Read a.ts');
    expect(t).toContain('↳Read b.ts');
  });

  it('gives a tool row a gap after a notice or next to a block, and none in a plain stack', () => {
    const html = transcript([
      { role: 'tool', callId: 'x', summary: 'Found 2 matches' },
      { role: 'tool', callId: 'y', summary: 'Found 3 matches' },
      { role: 'system', content: 'sandboxed' },
      { role: 'tool', callId: 'z', summary: 'Listed 2 entries' },
    ]);
    const tools = [...html.matchAll(/class="row row-tool( row--gap)?"/g)].map(m => !!m[1]);
    expect(tools).toEqual([false, false, true]);
  });

  it('puts a turn’s Worked line before the next prompt, and holds the last until idle', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'a', durationMs: 2000 },
      { role: 'system', content: 'end notice' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'b', durationMs: 65000 },
    ];
    const idle = text(transcript(messages, true));
    expect(idle.indexOf('end notice')).toBeLessThan(idle.indexOf('Worked for 2s'));
    expect(idle.indexOf('Worked for 2s')).toBeLessThan(idle.indexOf('two'));
    expect(idle).toMatch(/Worked for 1m 05s$/);
    expect(text(transcript(messages, false))).not.toContain('1m 05s');
  });
});

describe('the other side of the conversation', () => {
  const offScreen = { side: 'chat' as const, turns: 2 };
  const draw = (messages: WireMessage[]) =>
    text(renderToStaticMarkup(<Transcript messages={messages} idle offScreen={offScreen} />));

  it('says where the conversation is when this side holds no prompt', () => {
    expect(draw([])).toContain('This conversation is in chat mode. Switch to chat to see it');
    expect(draw([{ role: 'system', content: 'Agent mode' }])).toContain('in chat mode');
  });

  it('says nothing once this side has a prompt, or when the other side is empty', () => {
    expect(draw([{ role: 'user', content: 'fix the parser' }])).not.toContain('in chat mode');
    expect(text(transcript([]))).not.toContain('This conversation is in');
  });
});

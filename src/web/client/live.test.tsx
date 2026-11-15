import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WireLive } from '../protocol.js';
import { busyLabel, LiveTurn } from './LiveTurn.js';

const live = (over: Partial<WireLive> = {}): WireLive => ({
  phase: 'thinking',
  content: '',
  reasoning: '',
  tool: null,
  pending: null,
  plan: null,
  usage: null,
  subagent: false,
  note: false,
  typechecking: false,
  recovering: false,
  promptProgress: null,
  looping: false,
  ...over,
});

const draw = (l: WireLive, busy = true, planShown = true) =>
  renderToStaticMarkup(<LiveTurn live={l} busy={busy} planShown={planShown} />);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('LiveTurn', () => {
  it('streams reasoning and content as markdown, with the busy line', () => {
    const html = draw(live({ reasoning: 'hmm', content: 'A **bold** start' }));
    expect(text(html)).toContain('Thinking');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('class="busy busy--accent"');
  });

  it('draws bash output under the command indent, other tools flush', () => {
    expect(draw(live({ tool: { name: 'bash', output: 'x' } }))).toContain(
      'live-tool live-tool--command',
    );
    expect(draw(live({ tool: { name: '', output: 'x' } }))).toContain('class="live-tool"');
  });

  it('a pending call shows at once only when its output already streams', () => {
    const pending = { name: 'bash', since: 0, call: 1 };
    expect(text(draw(live({ pending })))).not.toContain('Running…');
    expect(text(draw(live({ pending, tool: { name: 'bash', output: 'o' } })))).toContain(
      '↳Running…',
    );
  });

  it('draws a compaction note stream as a note', () => {
    const html = draw(live({ note: true, reasoning: 'r', content: 'Established: x' }));
    expect(html).toContain('class="note"');
    expect(text(html)).toContain('Compaction note');
  });

  it('indents a subagent’s stream', () => {
    expect(draw(live({ subagent: true, content: 'x' }))).toContain('class="live nest"');
  });

  it('folds a long plan by the TUI rule and offers every step', () => {
    const plan = Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      text: `step ${i + 1}`,
      done: i < 3,
      waived: false,
    })) as unknown as NonNullable<WireLive['plan']>;
    const t = text(draw(live({ plan }), false));
    expect(t).toContain('steps 1–3 done');
    expect(t).toContain('4. step 4');
    expect(t).not.toContain('10. step 10');
    expect(t).toContain('… 3 more');
    expect(t).toContain('Show all 12 steps');
  });

  it('keeps the plan checklist when idle, and draws nothing else', () => {
    const plan = [
      { n: 1, text: 'Edit `a.ts`', paths: [], commands: [], snippets: [], done: true },
      { n: 2, text: 'Run tests', paths: [], commands: [], snippets: [], done: false },
      { n: 3, text: 'Skip', paths: [], commands: [], snippets: [], done: false, waived: true },
    ] as unknown as NonNullable<WireLive['plan']>;
    const html = draw(live({ plan, content: 'x' }), false);
    expect(text(html)).toContain('Plan 1/3 · 1 waived');
    expect(html).toContain('plan-step--done');
    expect(html).toContain('plan-step--next');
    expect(html).toContain('plan-step--waived');
    expect(html).not.toContain('busy');
    expect(draw(live({ plan }), true, false)).not.toContain('Plan 1/3');
    expect(draw(live(), false)).toBe('');
  });
});

describe('busyLabel', () => {
  it('ranks harness actions over the soft hint', () => {
    expect(busyLabel(live({ typechecking: true, looping: true })).text).toBe('Typechecking');
    expect(
      busyLabel(
        live({
          recovering: true,
          promptProgress: { total: 10000, cached: 0, processed: 4100, elapsedMs: 1000 },
        }),
      ).text,
    ).toMatch(/^Processing context 41%/);
    expect(busyLabel(live({ recovering: true, looping: true })).text).toBe(
      'Recovering from a loop',
    );
    expect(busyLabel(live({ looping: true })).text).toBe('Thinking — may be looping');
    expect(busyLabel(live({ phase: 'tool' })).text).toBe('Running tools');
  });
});

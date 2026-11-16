import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WireLive } from '../protocol.js';
import { WORKING_WORDS } from '../../ui/workingwords.js';
import { ReasoningBlock } from './blocks.js';
import { BusyLine, busyLabel, LiveTurn } from './LiveTurn.js';

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

const draw = (l: WireLive, busy = true, planShown = true, clockOffset: number | null = null) =>
  renderToStaticMarkup(
    <LiveTurn live={l} busy={busy} planShown={planShown} clockOffset={clockOffset} />,
  );
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('LiveTurn', () => {
  it('streams reasoning and content as markdown; the busy line is pinned by App, not here', () => {
    const html = draw(live({ reasoning: 'hmm', content: 'A **bold** start' }));
    expect(text(html)).toContain('Thinking');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('class="busy');
  });

  it('draws bash output under the command indent, other tools flush', () => {
    expect(draw(live({ tool: { name: 'bash', output: 'x' } }))).toContain(
      'live-tool live-tool--command',
    );
    expect(draw(live({ tool: { name: '', output: 'x' } }))).toContain('class="live-tool"');
  });

  it('a pending call shows at once only when its output already streams', () => {
    const pending = { name: 'bash', since: Date.now(), call: 1 };
    expect(text(draw(live({ pending })))).not.toContain('Running…');
    expect(text(draw(live({ pending, tool: { name: 'bash', output: 'o' } })))).toContain(
      '↳Running…',
    );
  });

  it('times a call from its server start, for a tab that joined mid-call', () => {
    // The server's clock runs a minute ahead of this tab's; the call started 7s ago on it.
    const offset = 60_000;
    const pending = { name: 'bash', since: Date.now() + offset - 7000, call: 1 };
    expect(text(draw(live({ pending }), true, true, offset))).toMatch(/Running….*7s/);
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
    // The ordinary turn, thinking or running tools, rotates the working verbs.
    expect(busyLabel(live({ phase: 'tool' }))).toEqual({ text: null, tone: 'accent' });
  });
});

describe('BusyLine', () => {
  const label = (html: string) => /class="busy-label"[^>]*>([^<]*)</.exec(html)?.[1];

  it('draws the TUI spinner and a working verb for the ordinary turn', () => {
    const html = renderToStaticMarkup(<BusyLine text={null} tone="accent" words />);
    expect(html).toContain('class="busy-spinner"');
    expect(html).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    const shown = label(html)!;
    expect(shown.endsWith('…')).toBe(true);
    expect(WORKING_WORDS).toContain(shown.slice(0, -1));
  });

  it('says Working with the verbs off, and keeps a harness state’s own words', () => {
    expect(label(renderToStaticMarkup(<BusyLine text={null} tone="accent" words={false} />))).toBe(
      'Working…',
    );
    expect(label(renderToStaticMarkup(<BusyLine text="Typechecking" tone="info" words />))).toBe(
      'Typechecking…',
    );
  });

  it('sweeps at the TUI’s pace for the label’s length', () => {
    const html = renderToStaticMarkup(<BusyLine text="Typechecking" tone="info" words={false} />);
    // (13 chars + 6 pause) × 2 ticks × 80ms.
    expect(html).toContain('animation-duration:3040ms');
  });
});

describe('ReasoningBlock', () => {
  it('keeps the whole thought in one window, as markdown with its line breaks', () => {
    const html = renderToStaticMarkup(
      <ReasoningBlock text={'one\n\n\ntwo\nthree **bold**\n- item'} live />,
    );
    expect(html).toContain('reasoning-window');
    expect(html).toContain(
      '<p>one</p><p>two\nthree <strong>bold</strong></p><ul><li><span>item</span></li></ul>',
    );
    expect(html).not.toContain('**');
  });

  it('live, offers no toggle; committed and long, the same window under one', () => {
    const long = 'a\nb\nc\nd\ne';
    expect(renderToStaticMarkup(<ReasoningBlock text={long} live />)).not.toContain('<details');
    const done = renderToStaticMarkup(<ReasoningBlock text={long} />);
    expect(done).toContain('<details');
    expect(done).toMatch(/5 lines<svg class="reasoning-chevron"/);
    // The chip says it opens; the preview carries no title of its own.
    expect(done).not.toContain('title=');
    expect(done).toMatch(/reasoning-window reasoning-tail/);
  });
});

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, {
  window,
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: window.HTMLElement,
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { BusyLine } = await import('./LiveTurn.js');

async function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (text: string | null, tone: string) =>
    act(async () => root.render(<BusyLine text={text} tone={tone} words={false} />));
  const span = () => container.querySelector('.busy-label') as HTMLElement;
  return { render, span };
}

describe('BusyLine sweep', () => {
  it('keeps one sweep while a harness label’s numbers move', async () => {
    const b = await mount();
    await b.render('Processing context 41%', 'prefill');
    const first = b.span();
    const pace = first.getAttribute('style');
    await b.render('Processing context 42% · ~1m 05s left', 'prefill');
    expect(b.span()).toBe(first);
    expect(b.span().textContent).toBe('Processing context 42% · ~1m 05s left…');
    // Re-timed, the running sweep would jump to another point of its cycle.
    expect(b.span().getAttribute('style')).toBe(pace);
  });

  it('starts a fresh sweep for another state', async () => {
    const b = await mount();
    await b.render('Processing context 99%', 'prefill');
    const first = b.span();
    await b.render('Typechecking', 'info');
    expect(b.span()).not.toBe(first);
  });
});

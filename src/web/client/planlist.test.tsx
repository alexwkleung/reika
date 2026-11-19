import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { WireLive } from '../protocol.js';

const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>',
);
Object.assign(globalThis, {
  window,
  document,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: window.HTMLElement,
});
// react-dom checks `'oninput' in document` once at load; without it it takes an old-IE polyfill.
Object.assign(document, { oninput: null });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { PlanList } = await import('./LiveTurn.js');

describe('PlanList toggle', () => {
  it('shows every step on request and folds again', async () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      n: i + 1,
      text: `step ${i + 1}`,
      done: i < 3,
      waived: false,
    })) as unknown as NonNullable<WireLive['plan']>;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<PlanList steps={steps} />));
    const toggle = () => container.querySelector('.plan-toggle') as HTMLButtonElement;
    const rows = () => container.querySelectorAll('.plan-step').length;
    expect(rows()).toBe(8);
    await act(async () => toggle().click());
    expect(rows()).toBe(12);
    expect(toggle().textContent).toBe('Show fewer steps');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle().click());
    expect(rows()).toBe(8);
    await act(async () => root.unmount());
  });
});

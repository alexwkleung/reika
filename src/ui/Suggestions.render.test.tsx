import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  Suggestions,
  suggestionRows,
  suggestionWindowStart,
  visibleSuggestionCount,
} from './Suggestions.js';
import type { SuggestionState } from './suggest.js';

const ROWS = 30;

function commandState(n: number): SuggestionState {
  const items = Array.from({ length: n }, (_, i) => ({
    value: `/cmd${i}`,
    display: `/cmd${i}  —  command ${i}`,
  }));
  return { kind: 'command', items, partial: '/' };
}

describe('suggestion window (#470)', () => {
  let prev: number | undefined;
  beforeEach(() => {
    prev = process.stdout.rows;
    Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'rows', { value: prev, configurable: true });
  });

  it('shrinks with the terminal but never below three items', () => {
    expect(visibleSuggestionCount(40)).toBe(8);
    expect(visibleSuggestionCount(26)).toBe(4);
    expect(visibleSuggestionCount(10)).toBe(3);
  });

  it('scrolls to keep the selection inside the window', () => {
    expect(suggestionWindowStart(5, 4, 8)).toBe(0);
    expect(suggestionWindowStart(25, 0, 8)).toBe(0);
    expect(suggestionWindowStart(25, 7, 8)).toBe(0);
    expect(suggestionWindowStart(25, 8, 8)).toBe(1);
    expect(suggestionWindowStart(25, 24, 8)).toBe(17);
  });

  it('a bare slash with every command matched renders a bounded list', () => {
    const state = commandState(25);
    const { lastFrame } = render(<Suggestions state={state} selectedIndex={0} />);
    const lines = lastFrame()!.split('\n');
    expect(lines).toHaveLength(suggestionRows(state));
    expect(lines.filter(l => l.includes('/cmd'))).toHaveLength(visibleSuggestionCount());
    expect(lastFrame()).toContain('1/25');
  });

  it('keeps the selected item on screen past the first window', () => {
    const state = commandState(25);
    const { lastFrame } = render(<Suggestions state={state} selectedIndex={20} />);
    expect(lastFrame()).toContain('› /cmd20');
    expect(lastFrame()).not.toContain('/cmd0 ');
    expect(lastFrame()).toContain('21/25');
  });

  it('a short list keeps its height and shows no position', () => {
    const state = commandState(2);
    const { lastFrame } = render(<Suggestions state={state} selectedIndex={0} />);
    expect(lastFrame()!.split('\n')).toHaveLength(suggestionRows(state));
    expect(lastFrame()).not.toContain('/2');
  });

  it('counts nothing when there is no list', () => {
    expect(suggestionRows(null)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { PayloadStore } from './payloads.js';

describe('PayloadStore', () => {
  it('round-trips content through put/get', () => {
    const store = new PayloadStore();
    const id = store.put('tool output bytes');
    expect(store.get(id)).toBe('tool output bytes');
    expect(store.size()).toBe(1);
  });

  it('clear() drops everything so a /new session starts empty', () => {
    const store = new PayloadStore();
    const id = store.put('stale payload from the previous session');
    store.clear();
    expect(store.get(id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});

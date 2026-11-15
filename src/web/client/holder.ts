// One mutable cell for useSyncExternalStore: the fold stays pure, this only holds its latest result.

export type Holder<T> = {
  get(): T;
  update(next: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
};

export function createHolder<T>(initial: T): Holder<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    update: next => {
      const updated = next(value);
      if (updated === value) return;
      value = updated;
      for (const listener of [...listeners]) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

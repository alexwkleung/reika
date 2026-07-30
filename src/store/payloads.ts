import { randomBytes } from 'node:crypto';

export class PayloadStore {
  private items = new Map<string, string>();

  put(content: string): string {
    const id = randomBytes(6).toString('hex');
    this.items.set(id, content);
    return id;
  }

  get(id: string): string | undefined {
    return this.items.get(id);
  }

  size(): number {
    return this.items.size;
  }

  // Payloads are only reachable through payloadIds on messages, so once /new wipes the
  // scrollback and stashes, everything in here is garbage — drop it rather than letting a
  // long-lived process accumulate every tool payload across sessions.
  clear(): void {
    this.items.clear();
  }
}

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
}

import type { Message } from '../src/types.js';

export type Fixture = {
  name: string;
  setup: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  assert: (ctx: AssertCtx) => AssertResult | Promise<AssertResult>;
};

export type AssertCtx = {
  cwd: string;
  messages: Message[];
  elapsedMs: number;
  toolCallCount: number;
};

export type AssertResult = { pass: true; note?: string } | { pass: false; reason: string };

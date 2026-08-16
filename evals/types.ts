import type { Message } from '../src/types.js';

export type Fixture = {
  name: string;
  setup: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  // Which tool set the turn gets. 'plan' is planTools() — read/list/grep/glob, no bash — the
  // configuration plan mode ships, and the only one where a capped result has no pipe to
  // aggregate its way around. Defaults to the full set.
  tools?: 'default' | 'plan';
  assert: (ctx: AssertCtx) => AssertResult | Promise<AssertResult>;
};

export type AssertCtx = {
  cwd: string;
  messages: Message[];
  elapsedMs: number;
  toolCallCount: number;
};

export type AssertResult = { pass: true; note?: string } | { pass: false; reason: string };

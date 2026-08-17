import type { Message } from '../src/types.js';

export type Fixture = {
  name: string;
  setup: Record<string, string>;
  prompt: string;
  timeoutMs?: number;
  // Which tool set the turn gets. 'plan' is planTools() — read/list/grep/glob, no bash — the
  // configuration plan mode ships, and the only one where a capped result has no pipe to
  // aggregate its way around. Defaults to the full set.
  //
  // NOTE this is the tool set ONLY; it does not put the turn in plan mode. Use `mode` for that.
  tools?: 'default' | 'plan';
  // Which prompt mode the turn runs in. 'plan' gets the plan system prompt, the stall/ceiling
  // force-write, and the `planFinal` stamp on its closing message — none of which `tools: 'plan'`
  // brings with it. Anything asserting on plan-mode behavior needs this, not just the tool set.
  // Defaults to 'agent'.
  mode?: 'agent' | 'plan';
  assert: (ctx: AssertCtx) => AssertResult | Promise<AssertResult>;
};

export type AssertCtx = {
  cwd: string;
  messages: Message[];
  elapsedMs: number;
  toolCallCount: number;
};

export type AssertResult = { pass: true; note?: string } | { pass: false; reason: string };

import type { Message } from '../src/types.js';

export type EvalMode = 'agent' | 'plan' | 'minimal' | 'grind';

export type Fixture = {
  name: string;
  setup: Record<string, string>;
  prompt: string;
  // A second prompt submitted into the SAME session once the first turn ends, with the same mode and
  // tools. Plan refinement (#46) is a two-turn behavior — the second prompt is what makes that turn a
  // revision of the plan the first one wrote — so without this it is unreachable from a fixture. The
  // assert sees the whole conversation, both turns included.
  followUp?: string;
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
  // Defaults to 'agent'. 'minimal' and 'grind' run their own prompt and tool list; `--mode=<m>` on
  // the command line overrides this for every selected fixture, which is how one task is compared
  // across modes.
  mode?: EvalMode;
  // Commit the setup files into a fresh git repo before the turn, for fixtures that grade whether
  // the model reviewed its own `git diff`.
  gitInit?: boolean;
  assert: (ctx: AssertCtx) => AssertResult | Promise<AssertResult>;
};

export type AssertCtx = {
  cwd: string;
  messages: Message[];
  elapsedMs: number;
  toolCallCount: number;
};

export type AssertResult = { pass: true; note?: string } | { pass: false; reason: string };

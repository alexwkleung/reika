import type { Config, Tool } from '../types.js';
import { readTool } from './read.js';
import { listTool } from './list.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool, minimalBashTool, readOnlyBashTool } from './bash.js';
import { subagentTool } from './subagent.js';
import { askUserTool } from './ask.js';
import { fetchUrlTool } from './fetch.js';
import { createSearchTool } from './search.js';
import { SearxngProvider } from '../search/searxng.js';
import { CdpSearchProvider } from '../search/cdp.js';
import { ChromeHost } from '../search/_chrome.js';
import type { SearchProvider } from '../search/types.js';

// `offline` (#392): the machine has no route out (tools/_net.ts `isOffline`), so neither web
// tool goes in the list — a tool the model can see is a tool it will call, and every call would
// fail. Decided once at startup and held for the session on purpose: the tool list is part of the
// round-0 prefix, and changing it mid-session throws away the KV cache (#69/#81). The caller
// prints the reason to the scrollback so a missing `search` is not a mystery.
export type ToolListOptions = { offline?: boolean };

export function defaultTools(config?: Config, opts: ToolListOptions = {}): Tool[] {
  const tools: Tool[] = [
    readTool,
    listTool,
    grepTool,
    globTool,
    editTool,
    writeTool,
    bashTool,
    subagentTool,
    ...webTools(config, opts),
  ];
  if (askEnabled()) tools.push(askUserTool);
  return tools;
}

// The web pair. `fetch_url` is unconditional, unlike `search`: fetching a known URL needs no
// provider or credential, and the harness itself puts URLs in front of the model (pasted-link
// expansion, URL grounding) that it must be able to follow up on. Gating it behind the search
// provider left a reika without SearXNG unable to read a link the user had just handed it.
function webTools(config: Config | undefined, opts: ToolListOptions): Tool[] {
  if (opts.offline) return [];
  const tools: Tool[] = [fetchUrlTool];
  const search = makeSearchProvider(config);
  if (search) tools.push(createSearchTool(search));
  return tools;
}

// On by default (#198), off with REIKA_ASK=0 — the polarity every other default-on switch uses
// (cf. `pasteFetch`). Kept switchable rather than hardcoded for a specific reason beyond
// convention: this tool's whole effect is to PREVENT the failure it was built for, so the baseline
// arm of any measurement of that failure needs a build without it. The agent prompt's rule 7 keys
// off the tool list (prompt.ts `canAsk`), so it disappears on its own when this is off and the two
// arms differ by exactly one variable. Read per call, not at module load, so toggling it doesn't
// need a restart.
function askEnabled(): boolean {
  return process.env.REIKA_ASK !== '0';
}

// EXPERIMENT (plan mode): read-only exploration tools. No edit/write/subagent — so a model in plan
// mode structurally cannot mutate the repo. The only failure mode left is over-exploration, which the
// ledger + convergence nudge target.
//
// `readOnlyBashTool` (#109) is the shell, narrowed to commands `isProvablyReadOnly` can PROVE
// read-only. ON by default since 2026-09-18: plan mode is agent mode minus mutation, and a pipeline
// (`grep … | head`, `find`, `wc -l`) is inspection the four dedicated tools cannot express. The
// guarantee is unchanged in kind — plan mode still cannot mutate the repo — but it is enforced by
// a classifier rather than by the tool's absence, which is why `REIKA_PLAN_BASH=0` can still take
// it back out on its own. Read per call, not at module load, so toggling it doesn't need a restart.
export function planTools(): Tool[] {
  const tools = [readTool, listTool, grepTool, globTool];
  // `ask_user` belongs here as much as in agent mode: plan mode is where an ambiguity should surface,
  // before any code is written, and the tool touches nothing in the repo. It is also outside the
  // withdrawal set (LOOP_WITHDRAW_TOOLS) on purpose — a model that has been told to stop exploring
  // still needs a way to say what it cannot decide. The plan prompt names it (rule 5, #272), keyed
  // off this list through `canAsk` exactly as the agent prompt's rule 7 is, so REIKA_ASK=0 removes
  // the tool and the rule together in both modes.
  if (askEnabled()) tools.push(askUserTool);
  if (process.env.REIKA_PLAN_BASH !== '0') tools.push(readOnlyBashTool);
  return tools;
}

// Minimal mode (#391): the shell, and nothing else. For setups where the upfront context load and
// its prefill are the cost that matters — SSD-streamed models that are beefy but absurdly slow —
// and for testing the harness against a model with no project information to lean on.
//
// No web tools even when a provider is configured: the mode's premise is that the model works from
// what the shell shows it, and `search` is the one tool whose results are neither the repo nor
// anything the harness can ground. `fetch_url` goes with it rather than staying unconditional as it
// does in agent mode, since the two affordances that put URLs in front of the model here
// (pasted-link expansion, URL grounding) are prompt-level and unaffected.
//
// `ask_user` stays, on the same reasoning it stays in plan mode: it loads no context, touches
// nothing, and costs one tool definition, and the prompt's permission rule is keyed to its presence
// through `canAsk` — so REIKA_ASK=0 removes the tool and the rule together here too. "Bash only"
// is about the work surface, not a literal count of one.
export function minimalTools(): Tool[] {
  const tools: Tool[] = [minimalBashTool];
  if (askEnabled()) tools.push(askUserTool);
  return tools;
}

// Tools available in chat mode — knowledge-only, no filesystem or shell access.
export function chatTools(config?: Config, opts: ToolListOptions = {}): Tool[] {
  return webTools(config, opts);
}

// Exported for the precedence test: which provider wins when both are configured is a rule, and a
// rule stated only in a comment is one refactor away from silently inverting.
export function makeSearchProvider(config?: Config): SearchProvider | undefined {
  // Both providers are local-first — no third-party tool-use APIs, no credentials. CDP wins when
  // enabled (#235): SearXNG reaches engines as a bare HTTP client and gets CAPTCHA'd for it, where
  // a real browser on a persistent profile keeps being served. SearXNG stays the fallback so a
  // machine without Chrome, or with the flag off, is exactly as it was.
  if (config?.cdpSearch) {
    return new CdpSearchProvider(new ChromeHost({ port: config.cdpPort }));
  }
  if (config?.searxngUrl) return new SearxngProvider(config.searxngUrl);
  return undefined;
}

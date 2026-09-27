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
import { platform } from 'node:os';
import { ChromeHost, findChrome } from '../search/_chrome.js';
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
//
// The web pair (#290) is in the list on the same argument: exploring a codebase is the mode's job,
// but a plan can turn on something the repo cannot settle — a library's docs, an API's shape, the
// issue the plan answers — and grounding that is the read-only affordance `read` is, one hop out.
// Same gating as agent mode, for the same reasons: `fetch_url` unconditionally, `search` only when a
// provider is configured (`makeSearchProvider`), and neither when the machine has no route out
// (#392). Given at session start, not per turn — the list is part of the round-0 prefix.
export function planTools(config?: Config, opts: ToolListOptions = {}): Tool[] {
  const tools = [readTool, listTool, grepTool, globTool];
  // `ask_user` belongs here as much as in agent mode: plan mode is where an ambiguity should surface,
  // before any code is written, and the tool touches nothing in the repo. It is also outside the
  // withdrawal set (LOOP_WITHDRAW_TOOLS) on purpose — a model that has been told to stop exploring
  // still needs a way to say what it cannot decide. The plan prompt names it (rule 5, #272), keyed
  // off this list through `canAsk` exactly as the agent prompt's rule 7 is, so REIKA_ASK=0 removes
  // the tool and the rule together in both modes.
  if (askEnabled()) tools.push(askUserTool);
  if (process.env.REIKA_PLAN_BASH !== '0') tools.push(readOnlyBashTool);
  tools.push(...webTools(config, opts));
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

export type SearchBackend = 'cdp' | 'searxng';
export type SearchChoice = {
  backend: SearchBackend | undefined;
  // Why CDP was picked: the user asked for it, or a browser was found. Worded differently in the
  // notice, since "found automatically" is the case a user did not configure.
  cdpVia?: 'flag' | 'detected';
  // SearXNG is configured but CDP outranks it — the one case the user must be told about.
  searxngShadowed: boolean;
};
export type SearchProbe = { platform: NodeJS.Platform; hasChrome: () => boolean };

const systemProbe: SearchProbe = {
  platform: platform(),
  hasChrome: () => findChrome() !== undefined,
};

// Exported for the precedence test: which provider wins when both are configured is a rule, and a
// rule stated only in a comment is one refactor away from silently inverting.
//
// Both providers are local-first — no third-party tool-use APIs, no credentials. CDP wins whenever
// it is chosen (#235): SearXNG reaches engines as a bare HTTP client and gets CAPTCHA'd for it,
// where a real browser on a persistent profile keeps being served. Auto-detection is macOS-only
// because only there does the launch stay out of sight (`open -g -na`); elsewhere a Chrome window
// would pop up and take focus on a search nobody opted into. Detection is an access check on a few
// fixed paths — nothing launches until the first search.
export function chooseSearchBackend(
  config?: Config,
  probe: SearchProbe = systemProbe,
): SearchChoice {
  const mode = config?.cdpSearch ?? 'off';
  const cdpVia =
    mode === 'on'
      ? 'flag'
      : mode === 'auto' && probe.platform === 'darwin' && probe.hasChrome()
        ? 'detected'
        : undefined;
  const searxng = Boolean(config?.searxngUrl);
  if (cdpVia) return { backend: 'cdp', cdpVia, searxngShadowed: searxng };
  return { backend: searxng ? 'searxng' : undefined, searxngShadowed: false };
}

export function makeSearchProvider(
  config?: Config,
  probe: SearchProbe = systemProbe,
): SearchProvider | undefined {
  const { backend } = chooseSearchBackend(config, probe);
  if (backend === 'cdp') return new CdpSearchProvider(new ChromeHost({ port: config?.cdpPort }));
  if (backend === 'searxng' && config?.searxngUrl) return new SearxngProvider(config.searxngUrl);
  return undefined;
}

// The startup receipt when both providers are configured: a SearXNG URL the user set that silently
// goes unused reads as SearXNG being broken. Every session, not once — it describes a standing
// config the user can resolve in one line.
export function searchPrecedenceNotice(choice: SearchChoice): string | undefined {
  if (!choice.searxngShadowed) return undefined;
  const how = choice.cdpVia === 'detected' ? 'Chrome, found automatically' : 'Chrome';
  return `Web search uses ${how} (CDP), which takes precedence over REIKA_SEARXNG_URL. Set REIKA_CDP_SEARCH=0 to search through SearXNG instead.`;
}

import type { Config, Tool } from '../types.js';
import { readTool } from './read.js';
import { listTool } from './list.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool, readOnlyBashTool } from './bash.js';
import { subagentTool } from './subagent.js';
import { fetchUrlTool } from './fetch.js';
import { createSearchTool } from './search.js';
import { SearxngProvider } from '../search/searxng.js';
import type { SearchProvider } from '../search/types.js';

export function defaultTools(config?: Config): Tool[] {
  const tools: Tool[] = [
    readTool,
    listTool,
    grepTool,
    globTool,
    editTool,
    writeTool,
    bashTool,
    subagentTool,
    // Unconditional, unlike `search`: fetching a known URL needs no provider or credential, and
    // the harness itself puts URLs in front of the model (pasted-link expansion, URL grounding)
    // that it must be able to follow up on. Gating it behind the search provider left a reika
    // without SearXNG unable to read a link the user had just handed it.
    fetchUrlTool,
  ];
  const search = makeSearchProvider(config);
  if (search) tools.push(createSearchTool(search));
  return tools;
}

// EXPERIMENT (plan mode): read-only exploration tools. No edit/write/subagent — so a model in plan
// mode structurally cannot mutate the repo. The only failure mode left is over-exploration, which the
// ledger + convergence nudge target.
//
// REIKA_PLAN_BASH=1 (default off, experimental — #109) adds `readOnlyBashTool`: the shell, narrowed
// to commands `isReadOnlyShell` can PROVE read-only. Plan mode's guarantee is unchanged in kind — it
// still cannot mutate the repo — but it is now enforced by a classifier rather than by the tool's
// absence, so it is flagged separately from plan mode itself and can be turned off on its own. Read
// per call, not at module load, so toggling it doesn't need a restart.
export function planTools(): Tool[] {
  const tools = [readTool, listTool, grepTool, globTool];
  if (process.env.REIKA_PLAN_BASH === '1') tools.push(readOnlyBashTool);
  return tools;
}

// Tools available in chat mode — knowledge-only, no filesystem or shell access.
export function chatTools(config?: Config): Tool[] {
  const tools: Tool[] = [fetchUrlTool];
  const search = makeSearchProvider(config);
  if (search) tools.push(createSearchTool(search));
  return tools;
}

function makeSearchProvider(config?: Config): SearchProvider | undefined {
  // SearXNG only — local-first, no third-party tool-use APIs. The SearchProvider
  // interface stays vendor-neutral so another provider can be slotted in here later.
  if (config?.searxngUrl) return new SearxngProvider(config.searxngUrl);
  return undefined;
}

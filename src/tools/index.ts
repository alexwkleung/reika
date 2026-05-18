import type { Config, Tool } from '../types.js';
import { readTool } from './read.js';
import { listTool } from './list.js';
import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool } from './bash.js';
import { subagentTool } from './subagent.js';
import { fetchUrlTool } from './fetch.js';
import { createSearchTool } from './search.js';
import { TavilyProvider } from '../search/tavily.js';
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
  ];
  const search = makeSearchProvider(config);
  if (search) {
    tools.push(createSearchTool(search));
    tools.push(fetchUrlTool);
  }
  return tools;
}

// Tools available in chat mode — knowledge-only, no filesystem or shell access.
export function chatTools(config?: Config): Tool[] {
  const tools: Tool[] = [];
  const search = makeSearchProvider(config);
  if (search) {
    tools.push(createSearchTool(search));
    tools.push(fetchUrlTool);
  }
  return tools;
}

function makeSearchProvider(config?: Config): SearchProvider | undefined {
  // SearXNG takes precedence over Tavily when both are configured — local-first.
  if (config?.searxngUrl) return new SearxngProvider(config.searxngUrl);
  if (config?.tavilyApiKey) return new TavilyProvider(config.tavilyApiKey);
  return undefined;
}

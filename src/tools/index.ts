import type { Config, Tool } from '../types.js';
import { readTool } from './read.js';
import { listTool } from './list.js';
import { grepTool } from './grep.js';
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
  const tools: Tool[] = [readTool, listTool, grepTool, editTool, writeTool, bashTool, subagentTool];

  // SearXNG takes precedence over Tavily when both are configured — local-first.
  let provider: SearchProvider | undefined;
  if (config?.searxngUrl) {
    provider = new SearxngProvider(config.searxngUrl);
  } else if (config?.tavilyApiKey) {
    provider = new TavilyProvider(config.tavilyApiKey);
  }

  if (provider) {
    tools.push(createSearchTool(provider));
    tools.push(fetchUrlTool);
  }

  return tools;
}

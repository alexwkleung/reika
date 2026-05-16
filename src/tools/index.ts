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

export function defaultTools(config?: Config): Tool[] {
  const tools: Tool[] = [readTool, listTool, grepTool, editTool, writeTool, bashTool, subagentTool];
  if (config?.tavilyApiKey) {
    tools.push(createSearchTool(new TavilyProvider(config.tavilyApiKey)));
    tools.push(fetchUrlTool);
  }
  return tools;
}

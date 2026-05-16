import type { Tool } from '../types.js';
import { readTool } from './read.js';
import { listTool } from './list.js';
import { grepTool } from './grep.js';
import { editTool } from './edit.js';
import { writeTool } from './write.js';
import { bashTool } from './bash.js';
import { subagentTool } from './subagent.js';

export function defaultTools(): Tool[] {
  return [readTool, listTool, grepTool, editTool, writeTool, bashTool, subagentTool];
}

import type { Tool } from "../types.js";
import { readTool } from "./read.js";
import { listTool } from "./list.js";
import { grepTool } from "./grep.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";

export function defaultTools(): Tool[] {
  return [readTool, listTool, grepTool, editTool, writeTool];
}

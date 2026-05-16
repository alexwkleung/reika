export type CommandSpec = {
  name: string;
  desc: string;
};

export const COMMANDS: CommandSpec[] = [
  { name: "help", desc: "show this list" },
  { name: "new", desc: "reset conversation, tokens, mode" },
  { name: "clear", desc: "alias of /new" },
  { name: "cd", desc: "change cwd (re-indexes repo map)" },
  { name: "shell", desc: "enter shell mode (raw bash, no model)" },
  { name: "agent", desc: "return to agent mode" },
  { name: "model", desc: "show current model and base URL" },
  { name: "cwd", desc: "show working directory" },
  { name: "tokens", desc: "show token usage this session" },
  { name: "exit", desc: "exit Reika" },
  { name: "quit", desc: "alias of /exit" },
];

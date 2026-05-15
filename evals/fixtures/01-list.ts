import type { Fixture } from '../types.js';
import { calledTool, lastAssistantContent } from '../util.js';

export const fixture: Fixture = {
  name: 'list-basic',
  setup: {
    'README.md': '# test\n',
    'src/main.ts': 'console.log("hi");\n',
    'package.json': '{"name":"t"}',
  },
  prompt: 'what files are in this project? give me a list.',
  assert: ({ messages }) => {
    if (!calledTool(messages, 'list')) {
      return { pass: false, reason: 'did not call list tool' };
    }
    const text = lastAssistantContent(messages);
    if (!text) return { pass: false, reason: 'no final assistant message' };
    const mentions = ['README', 'main.ts', 'package.json'].filter(f => text.includes(f));
    if (mentions.length < 2) {
      return { pass: false, reason: `names only ${mentions.length}/3 files` };
    }
    return { pass: true };
  },
};

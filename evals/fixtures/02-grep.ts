import type { Fixture } from '../types.js';
import { calledTool, lastAssistantContent } from '../util.js';

export const fixture: Fixture = {
  name: 'grep-symbol',
  setup: {
    'a.ts': 'export const myWidget = 1;\nconst other = 2;\n',
    'b.ts': 'import { myWidget } from "./a.js";\nconsole.log(myWidget);\n',
    'c.ts': 'export const unrelated = 3;\n',
  },
  prompt: 'find all places that reference myWidget',
  assert: ({ messages }) => {
    if (!calledTool(messages, 'grep')) {
      return { pass: false, reason: 'did not call grep tool' };
    }
    const text = lastAssistantContent(messages);
    if (!text) return { pass: false, reason: 'no final assistant message' };
    const hasA = text.includes('a.ts');
    const hasB = text.includes('b.ts');
    if (!hasA || !hasB) {
      return { pass: false, reason: `missing files in response (a.ts: ${hasA}, b.ts: ${hasB})` };
    }
    return { pass: true };
  },
};

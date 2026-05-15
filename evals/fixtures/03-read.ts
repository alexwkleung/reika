import type { Fixture } from '../types.js';
import { calledTool, lastAssistantContent } from '../util.js';

export const fixture: Fixture = {
  name: 'read-fact',
  setup: {
    'config.json': '{"port": 7777, "name": "test", "feature": "alpha"}',
  },
  prompt: 'what port is configured in config.json?',
  assert: ({ messages }) => {
    if (!calledTool(messages, 'read')) {
      return { pass: false, reason: 'did not call read tool' };
    }
    const text = lastAssistantContent(messages);
    if (!text) return { pass: false, reason: 'no final assistant message' };
    if (!text.includes('7777')) {
      return { pass: false, reason: 'response did not mention port 7777' };
    }
    return { pass: true };
  },
};

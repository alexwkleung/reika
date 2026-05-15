import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture } from '../types.js';

export const fixture: Fixture = {
  name: 'write-new-file',
  setup: {
    'README.md': '# scratch\n',
  },
  prompt:
    'create a file src/util.ts that exports a function called greet(name) returning the string "hello, " followed by the name.',
  assert: async ({ cwd }) => {
    let content: string;
    try {
      content = await readFile(join(cwd, 'src/util.ts'), 'utf8');
    } catch {
      return { pass: false, reason: 'src/util.ts not created' };
    }
    if (!/\bgreet\b/.test(content)) {
      return { pass: false, reason: 'greet symbol not present' };
    }
    if (!/hello/i.test(content)) {
      return { pass: false, reason: '"hello" string not present' };
    }
    if (!/export/.test(content)) {
      return { pass: false, reason: 'no export keyword in file' };
    }
    return { pass: true };
  },
};

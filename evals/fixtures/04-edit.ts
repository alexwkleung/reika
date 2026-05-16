import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fixture } from '../types.js';

export const fixture: Fixture = {
  name: 'edit-comment',
  setup: {
    'src/foo.ts': 'export const widget = 42;\n',
  },
  prompt: 'add a comment "// the answer" on the line above the widget export in src/foo.ts',
  assert: async ({ cwd }) => {
    const content = await readFile(join(cwd, 'src/foo.ts'), 'utf8');
    if (!content.includes('// the answer')) {
      return { pass: false, reason: 'comment not present in file' };
    }
    const commentIdx = content.indexOf('// the answer');
    const exportIdx = content.indexOf('export const widget');
    if (exportIdx === -1) {
      return { pass: false, reason: 'export was removed or modified' };
    }
    if (commentIdx > exportIdx) {
      return { pass: false, reason: 'comment is below the export, not above' };
    }
    return { pass: true };
  },
};

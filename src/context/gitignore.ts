import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export async function loadGitignore(cwd: string): Promise<Ignore> {
  const ig = ignore();
  for (const path of [join(cwd, '.gitignore'), join(cwd, '.git', 'info', 'exclude')]) {
    try {
      const text = await readFile(path, 'utf8');
      ig.add(text);
    } catch {
      // missing file is fine
    }
  }
  return ig;
}

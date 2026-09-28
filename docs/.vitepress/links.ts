import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug } from 'github-slugger';
import type MarkdownIt from 'markdown-it';

// The pages are written for GitHub first: every link is a plain relative path that works when
// GitHub renders docs/. This rule adapts those links for the site at parse time, so there is one
// way to write a link and the site follows it.

const DOCS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = resolve(DOCS_DIR, '..');
const REPO_BLOB = 'https://github.com/alexwkleung/reika/blob/main';
const REPO_TREE = 'https://github.com/alexwkleung/reika/tree/main';

export const brokenLinks = new Set<string>();

function reportBroken(message: string): void {
  if (brokenLinks.has(message)) return;
  brokenLinks.add(message);
  console.warn(`[github-links] ${message}`);
}

// VitePress's own slugger differs from GitHub's on punctuation (`AGENTS.md` → agents-md vs
// agentsmd); using GitHub's on the site is what lets one #anchor work in both places.
export const githubSlugify = (text: string) => slug(text);

const headingCache = new Map<string, Set<string>>();

function headingSlugs(file: string): Set<string> {
  const cached = headingCache.get(file);
  if (cached) return cached;
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '');
    slugs.add(slug(text));
  }
  headingCache.set(file, slugs);
  return slugs;
}

function adaptHref(href: string, fromFile: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) return href;
  if (href.startsWith('#')) {
    if (!headingSlugs(fromFile).has(href.slice(1))) {
      reportBroken(`${relative(REPO_DIR, fromFile)} → ${href} (no heading ${href})`);
    }
    return href;
  }
  const [path, hash] = href.split('#', 2);
  const target = resolve(dirname(fromFile), decodeURIComponent(path));
  const where = `${relative(REPO_DIR, fromFile)} → ${href}`;

  if (!existsSync(target)) {
    reportBroken(`${where} (no such file)`);
    return href;
  }
  if (hash && target.endsWith('.md') && !headingSlugs(target).has(hash)) {
    reportBroken(`${where} (no heading #${hash})`);
  }
  if (target.startsWith(DOCS_DIR + sep)) return href;

  // The README is the repo's landing page and the site's home page summarizes it.
  if (target === resolve(REPO_DIR, 'README.md')) return '/';
  const base = statSync(target).isDirectory() ? REPO_TREE : REPO_BLOB;
  return `${base}/${relative(REPO_DIR, target).split(sep).join('/')}${hash ? `#${hash}` : ''}`;
}

export function githubLinks(md: MarkdownIt): void {
  md.core.ruler.push('github_links', state => {
    const relativePath: string | undefined = state.env?.relativePath;
    if (!relativePath) return;
    const fromFile = resolve(DOCS_DIR, relativePath);
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open') continue;
        const href = token.attrGet('href');
        if (href) token.attrSet('href', adaptHref(href, fromFile));
      }
    }
  });
}

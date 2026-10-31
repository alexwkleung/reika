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

// A zh page with no translation yet is a stub whose body is `<!--@include: ../page.md-->`: the
// site shows the English text inside the zh locale, so a reader who switched language stays there.
// The included links were written relative to the English file, so they resolve from it.
const ZH_DIR = resolve(DOCS_DIR, 'zh');
const INCLUDE_RE = /<!--\s*@include:\s*(\.\.\/[\w.-]+\.md)\s*-->/;
const includeCache = new Map<string, string | null>();

export function untranslatedSource(file: string): string | null {
  if (!file.startsWith(ZH_DIR + sep)) return null;
  if (includeCache.has(file)) return includeCache.get(file)!;
  const m = existsSync(file) ? INCLUDE_RE.exec(readFileSync(file, 'utf8')) : null;
  const source = m ? resolve(dirname(file), m[1]) : null;
  // VitePress leaves an include it cannot read as a silent comment, which would ship an empty page.
  if (source && !existsSync(source))
    reportBroken(`${relative(REPO_DIR, file)} → ${m![1]} (no such file)`);
  includeCache.set(file, source);
  return source;
}

const headingCache = new Map<string, Set<string>>();

function headingSlugs(file: string): Set<string> {
  file = untranslatedSource(file) ?? file;
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

// From a zh page, a link to an English page that has a zh copy goes to the copy, so the reader
// stays in the locale. A page's link to its own English original (the translation note) is kept,
// and so is a link to a section whose heading the translation renamed.
function zhCounterpart(target: string, fromFile: string, hash: string | undefined): string {
  if (!fromFile.startsWith(ZH_DIR + sep) || !target.endsWith('.md')) return target;
  if (!target.startsWith(DOCS_DIR + sep) || target.startsWith(ZH_DIR + sep)) return target;
  const copy = resolve(ZH_DIR, relative(DOCS_DIR, target));
  const ownOriginal = resolve(DOCS_DIR, relative(ZH_DIR, fromFile));
  if (target === ownOriginal || !existsSync(copy)) return target;
  return hash && !headingSlugs(copy).has(hash) ? target : copy;
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
  const baseFile = untranslatedSource(fromFile) ?? fromFile;
  const written = resolve(dirname(baseFile), decodeURIComponent(path));
  const where = `${relative(REPO_DIR, fromFile)} → ${href}`;

  if (!existsSync(written)) {
    reportBroken(`${where} (no such file)`);
    return href;
  }
  const target = zhCounterpart(written, fromFile, hash);
  if (hash && target.endsWith('.md') && !headingSlugs(target).has(hash)) {
    reportBroken(`${where} (no heading #${hash})`);
  }
  if (target.startsWith(DOCS_DIR + sep)) {
    if (target === written && baseFile === fromFile) return href;
    const rebased = relative(dirname(fromFile), target).split(sep).join('/');
    return hash ? `${rebased}#${hash}` : rebased;
  }

  // The README is the repo's landing page and the site's home page summarizes it.
  if (target === resolve(REPO_DIR, 'README.md')) {
    return fromFile.startsWith(ZH_DIR + sep) ? '/zh/' : '/';
  }
  const base = statSync(target).isDirectory() ? REPO_TREE : REPO_BLOB;
  return `${base}/${relative(REPO_DIR, target).split(sep).join('/')}${hash ? `#${hash}` : ''}`;
}

// An image in an included page is resolved by Vite from the stub's directory, not the original's.
function adaptImageSrc(src: string, fromFile: string): string {
  const source = untranslatedSource(fromFile);
  if (!source || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('/')) return src;
  const target = resolve(dirname(source), decodeURIComponent(src));
  return relative(dirname(fromFile), target).split(sep).join('/');
}

export function githubLinks(md: MarkdownIt): void {
  md.core.ruler.push('github_links', state => {
    const relativePath: string | undefined = state.env?.relativePath;
    if (!relativePath) return;
    const fromFile = resolve(DOCS_DIR, relativePath);
    for (const block of state.tokens) {
      for (const token of block.children ?? []) {
        if (token.type === 'image') {
          const src = token.attrGet('src');
          if (src) token.attrSet('src', adaptImageSrc(src, fromFile));
          continue;
        }
        if (token.type !== 'link_open') continue;
        const href = token.attrGet('href');
        if (href) token.attrSet('href', adaptHref(href, fromFile));
      }
    }
  });
}

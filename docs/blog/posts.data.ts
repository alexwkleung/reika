import { createContentLoader } from 'vitepress';

export interface Post {
  url: string;
  title: string;
  date: string;
  kind: 'research' | 'engineering';
  summary: string;
  draft: boolean;
}

declare const data: Post[];
export { data };

// Drafts live in blog/drafts/, which config.ts leaves out of a production build; the index has to
// drop them too, or it links to pages that were never built.
const isBuild = process.argv.includes('build');

// YAML reads an unquoted `date: 2026-10-19` as a Date, so a post's date can arrive either way.
function isoDay(date: Date | string): string {
  return date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
}

export default createContentLoader('blog/**/*.md', {
  transform(raw): Post[] {
    return raw
      .filter(page => !page.url.endsWith('/blog/'))
      .map(page => ({
        url: page.url,
        title: page.frontmatter.title,
        date: isoDay(page.frontmatter.date),
        kind: page.frontmatter.kind,
        summary: page.frontmatter.summary,
        draft: page.url.includes('/drafts/'),
      }))
      .filter(post => !(isBuild && post.draft))
      .sort((a, b) => b.date.localeCompare(a.date));
  },
});

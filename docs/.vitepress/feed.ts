import type { Post } from '../blog/posts.data';
import { SITE_URL } from './seo';

const RAW_DOCS = 'https://raw.githubusercontent.com/alexwkleung/reika/main/docs';

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A post's URL is `/blog/<slug>` (cleanUrls), so its source is `docs/blog/<slug>.md`.
function postUrl(post: Post): string {
  return `${SITE_URL}${post.url}`;
}

export function buildAtomFeed(posts: Post[]): string {
  const updated = posts[0] ? `${posts[0].date}T00:00:00Z` : new Date(0).toISOString();
  const entries = posts.map(post =>
    [
      '  <entry>',
      `    <title>${escapeXml(post.title)}</title>`,
      `    <link href="${postUrl(post)}"/>`,
      `    <id>${postUrl(post)}</id>`,
      `    <published>${post.date}T00:00:00Z</published>`,
      `    <updated>${post.date}T00:00:00Z</updated>`,
      `    <category term="${post.kind}"/>`,
      `    <summary>${escapeXml(post.summary)}</summary>`,
      '  </entry>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Reika blog</title>',
    '  <subtitle>Engineering notes and measured findings from building Reika.</subtitle>',
    `  <link href="${SITE_URL}/blog/"/>`,
    `  <link rel="self" href="${SITE_URL}/feed.xml"/>`,
    `  <id>${SITE_URL}/blog/</id>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>Alex Leung</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

// The spec reads `## Optional` as the part a model may skip, so the blog goes in ahead of it.
export function withBlogSection(llms: string, posts: Post[]): string {
  if (posts.length === 0) return llms;
  const section = [
    '## Blog',
    '',
    ...posts.map(post => `- [${post.title}](${RAW_DOCS}${post.url}.md): ${post.summary}`),
    '',
    '',
  ].join('\n');
  const optional = llms.indexOf('## Optional');
  return optional === -1
    ? `${llms.trimEnd()}\n\n${section}`
    : llms.slice(0, optional) + section + llms.slice(optional);
}

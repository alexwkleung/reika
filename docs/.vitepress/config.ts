import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';
import { brokenLinks, githubLinks, githubSlugify } from './links';

export default defineConfig({
  title: 'Reika - A coding agent CLI for local and hosted models',
  // Docs pages read "Page title | Reika" in the tab; the landing page opts out with
  // its own `titleTemplate: false` in index.md so it keeps the full site title.
  titleTemplate: ':title | Reika',
  description:
    'Coding agent CLI for local and hosted models, designed around small local models first.',
  cleanUrls: true,
  appearance: 'force-dark',
  srcExclude: ['demo/**', 'node_modules/**'],
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#17151a' }],
  ],
  markdown: {
    anchor: { slugify: githubSlugify },
    config: md => md.use(githubLinks),
  },
  themeConfig: {
    logo: '/favicon.svg',
    // Shown in the nav bar next to the logo, instead of falling back to the full
    // site `title` above; the document/tab title still uses `title`.
    siteTitle: 'Reika',
    nav: [
      { text: 'Install', link: '/getting-started' },
      { text: 'Usage', link: '/usage' },
      { text: 'Configuration', link: '/configuration' },
      { text: 'Findings', link: '/findings' },
      { text: 'Support', link: '/support' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Install', link: '/getting-started' },
          { text: 'Usage', link: '/usage' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Tools', link: '/tools' },
          { text: 'Instructions and skills', link: '/skills' },
          { text: 'Models', link: '/models' },
          { text: 'Platforms', link: '/platforms' },
          { text: 'Architecture', link: '/architecture' },
          { text: 'Findings', link: '/findings' },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Support', link: '/support' }],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/alexwkleung/reika' }],
    footer: {
      message:
        'Released under the Apache-2.0 license. Free to use; <a href="/support">support the project</a>.',
      copyright: 'Copyright 2026 Alex Leung',
    },
  },
  buildEnd(siteConfig) {
    if (brokenLinks.size > 0) {
      throw new Error(`Broken links:\n  ${[...brokenLinks].join('\n  ')}`);
    }
    // llms.txt is written by hand, so a page added to the sidebar has to be added there too.
    const llms = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8');
    const sidebar = siteConfig.site.themeConfig.sidebar as { items: { link: string }[] }[];
    const missing = sidebar
      .flatMap(group => group.items.map(item => `docs${item.link}.md`))
      .filter(path => !llms.includes(`/main/${path})`));
    if (missing.length > 0) {
      throw new Error(`Pages missing from docs/public/llms.txt:\n  ${missing.join('\n  ')}`);
    }
  },
});

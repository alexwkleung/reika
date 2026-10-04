import { defineConfig } from 'vitepress';
import { brokenLinks, githubLinks, githubSlugify } from './links';

export default defineConfig({
  title: 'Reika',
  description: 'Coding agent CLI for small local models, tuned for low quantization.',
  cleanUrls: true,
  appearance: 'force-dark',
  srcExclude: ['demo/**', 'node_modules/**'],
  markdown: {
    anchor: { slugify: githubSlugify },
    config: md => md.use(githubLinks),
  },
  themeConfig: {
    nav: [
      { text: 'Install', link: '/getting-started' },
      { text: 'Usage', link: '/usage' },
      { text: 'Configuration', link: '/configuration' },
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
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/alexwkleung/reika' }],
    footer: {
      message: 'Released under the Apache-2.0 license.',
      copyright: 'Copyright 2026 Alex Leung',
    },
  },
  buildEnd() {
    if (brokenLinks.size > 0) {
      throw new Error(`Broken links:\n  ${[...brokenLinks].join('\n  ')}`);
    }
  },
});

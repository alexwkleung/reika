import { defineConfig } from 'vitepress';
import { brokenLinks, githubLinks, githubSlugify } from './links';

export default defineConfig({
  title: 'Reika',
  description: 'Coding agent CLI for small local models, tuned for low quantization.',
  cleanUrls: true,
  srcExclude: ['demo/**', 'node_modules/**'],
  markdown: {
    anchor: { slugify: githubSlugify },
    config: md => md.use(githubLinks),
  },
  themeConfig: {
    sidebar: [
      {
        text: 'Guide',
        items: [
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
  },
  buildEnd() {
    if (brokenLinks.size > 0) {
      throw new Error(`Broken links:\n  ${[...brokenLinks].join('\n  ')}`);
    }
  },
});

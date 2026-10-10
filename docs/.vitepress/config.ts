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
  locales: {
    root: { label: 'English', lang: 'en', link: '/' },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Reika - 面向本地和托管模型的编程智能体 CLI',
      description: '面向本地和托管模型的编程智能体 CLI，优先围绕小型本地模型设计。',
      themeConfig: {
        nav: [
          { text: '安装（英文）', link: '/getting-started' },
          { text: '使用（英文）', link: '/usage' },
          { text: '配置（英文）', link: '/configuration' },
          { text: '研究结果（英文）', link: '/findings' },
          { text: '支持项目（英文）', link: '/support' },
          {
            text: '更新日志（英文）',
            link: 'https://github.com/alexwkleung/reika/blob/main/CHANGELOG.md',
          },
        ],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '安装（英文）', link: '/getting-started' },
              { text: '使用（英文）', link: '/usage' },
              { text: '配置（英文）', link: '/configuration' },
              { text: '工具（英文）', link: '/tools' },
              { text: '指令与技能（英文）', link: '/skills' },
              { text: '模型', link: '/zh/models' },
              { text: '平台', link: '/zh/platforms' },
              { text: '架构', link: '/zh/architecture' },
              { text: '研究结果（英文）', link: '/findings' },
            ],
          },
          {
            text: '项目',
            items: [{ text: '支持项目（英文）', link: '/support' }],
          },
        ],
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        langMenuLabel: '切换语言',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        darkModeSwitchLabel: '外观',
        footer: {
          message:
            '基于 Apache-2.0 许可证免费开源 · <a href="/support">支持项目（英文）</a> · <a href="/support#contact">联系（英文）</a>',
          copyright: 'Copyright 2026 Alex Leung',
        },
      },
    },
  },
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
    // Untranslated pages have no /zh/ counterpart; the language menu goes to each locale's home.
    i18nRouting: false,
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
      {
        text: 'Changelog',
        link: 'https://github.com/alexwkleung/reika/blob/main/CHANGELOG.md',
      },
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
        'Free and open source under the Apache-2.0 license · <a href="/support">Support the project</a> · <a href="/support#contact">Contact</a>',
      copyright: 'Copyright 2026 Alex Leung',
    },
  },
  buildEnd(siteConfig) {
    if (brokenLinks.size > 0) {
      throw new Error(`Broken links:\n  ${[...brokenLinks].join('\n  ')}`);
    }
    // llms.txt covers the canonical English sidebar; translated sidebars are exempt.
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

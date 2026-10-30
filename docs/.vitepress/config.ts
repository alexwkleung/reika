import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfigWithTheme } from 'vitepress';
import { brokenLinks, githubLinks, githubSlugify, untranslatedSource } from './links';
import { SITE_URL, languageAlternates, pageDescriptions, siteNameHead, socialHead } from './seo';
import type { TranslationTheme } from './theme/translations';

const DOCS_DIR = fileURLToPath(new URL('../', import.meta.url));
const zhFile = (url: string) => `${DOCS_DIR}${url.replace(/^\/|\/$/g, '') || 'index'}.md`;
// An untranslated zh page canonicalizes to, and borrows the description of, the English page it shows.
const englishPath = (relativePath: string) =>
  untranslatedSource(`${DOCS_DIR}${relativePath}`)
    ? relativePath.replace(/^zh\//, '')
    : relativePath;
// The English path of a page that has a real zh translation, from either side of the pair.
const translatedPair = (relativePath: string) => {
  const english = relativePath.replace(/^zh\//, '');
  const zh = `${DOCS_DIR}zh/${english}`;
  return existsSync(zh) && !untranslatedSource(zh) ? english : null;
};
const zhPages = readdirSync(`${DOCS_DIR}zh`, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
  .map(entry => entry.name);

export default defineConfigWithTheme<TranslationTheme>({
  title: 'Reika - A coding agent CLI for local and hosted models',
  // Docs pages read "Page title | Reika" in the tab; the landing page opts out with
  // its own `titleTemplate: false` in index.md so it keeps the full site title.
  titleTemplate: ':title | Reika',
  description:
    "Reika is an open-source coding agent CLI for local and hosted models, built for small local models first: careful with context, and says when it's stuck.",
  cleanUrls: true,
  appearance: 'force-dark',
  vite: {
    // Swaps the default theme's language menus for ones that route to a page's zh copy. This
    // matches VitePress's internal component paths and deep-imports its dist files, neither of
    // which is public API, so check the language switcher after any VitePress upgrade.
    resolve: {
      alias: ['VPNavBarTranslations', 'VPNavScreenTranslations', 'VPNavBarExtra'].map(name => ({
        find: new RegExp(`^.*\\/${name}\\.vue$`),
        replacement: fileURLToPath(new URL(`./theme/${name}.vue`, import.meta.url)),
      })),
    },
  },
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
          { text: '安装（英文）', link: '/zh/getting-started' },
          { text: '使用（英文）', link: '/zh/usage' },
          { text: '配置（英文）', link: '/zh/configuration' },
          { text: '研究结果（英文）', link: '/zh/findings' },
          { text: '支持项目（英文）', link: '/zh/support' },
          {
            text: '更新日志（英文）',
            link: 'https://github.com/alexwkleung/reika/blob/main/CHANGELOG.md',
          },
        ],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '安装（英文）', link: '/zh/getting-started' },
              { text: '使用（英文）', link: '/zh/usage' },
              { text: '配置（英文）', link: '/zh/configuration' },
              { text: '工具（英文）', link: '/zh/tools' },
              { text: '指令与技能（英文）', link: '/zh/skills' },
              { text: '模型', link: '/zh/models' },
              { text: '平台', link: '/zh/platforms' },
              { text: '架构', link: '/zh/architecture' },
              { text: '研究结果（英文）', link: '/zh/findings' },
            ],
          },
          {
            text: '项目',
            items: [{ text: '支持项目（英文）', link: '/zh/support' }],
          },
        ],
        outline: { label: '本页目录' },
        docFooter: { prev: '上一篇', next: '下一篇' },
        langMenuLabel: '切换语言',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        footer: {
          message:
            '基于 Apache-2.0 许可证免费开源 · <a href="/zh/support">支持项目（英文）</a> · <a href="/zh/support#contact">联系（英文）</a>',
          copyright: 'Copyright 2026 Alex Leung',
        },
      },
    },
  },
  srcExclude: ['demo/**', 'node_modules/**'],
  sitemap: {
    hostname: SITE_URL,
    // A zh page that only includes the English text is the English page's duplicate, not its own.
    transformItems: items => items.filter(item => !untranslatedSource(zhFile(item.url))),
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#17151a' }],
  ],
  transformPageData(pageData) {
    const description = pageDescriptions[englishPath(pageData.relativePath)];
    if (description) pageData.description = description;
  },
  transformHead({ pageData, title, description }) {
    if (pageData.isNotFound) return [];
    const pair = translatedPair(pageData.relativePath);
    return [
      ...socialHead(
        { ...pageData, relativePath: englishPath(pageData.relativePath) },
        title,
        description,
      ),
      ...(pair ? languageAlternates(pair) : []),
      ...siteNameHead(pageData.relativePath),
    ];
  },
  markdown: {
    anchor: { slugify: githubSlugify },
    config: md => md.use(githubLinks),
  },
  themeConfig: {
    // The custom language menus only route to pages that exist in docs/zh/, translated or included.
    i18nRouting: false,
    translatedPages: zhPages.map(name => name.slice(0, -3)),
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
    const undescribed = sidebar
      .flatMap(group => group.items.map(item => `${item.link.slice(1)}.md`))
      .filter(path => !pageDescriptions[path])
      // A zh translation needs its own; the landing page uses the zh locale's description.
      .concat(
        zhPages
          .map(name => `zh/${name}`)
          .filter(
            path => path !== 'zh/index.md' && translatedPair(path) && !pageDescriptions[path],
          ),
      );
    if (undescribed.length > 0) {
      throw new Error(
        `Pages missing from pageDescriptions in seo.ts:\n  ${undescribed.join('\n  ')}`,
      );
    }
  },
});

import type { HeadConfig, PageData } from 'vitepress';

export const SITE_URL = 'https://reikacode.com';

// Per-page meta descriptions live here rather than in frontmatter, which GitHub renders as a table
// on every docs page. The landing page falls back to the site description in config.ts.
export const pageDescriptions: Record<string, string> = {
  'getting-started.md':
    'Install Reika with npm, pnpm or Homebrew, serve a model with llama.cpp, MLX or vLLM, or point it at a hosted API, and run your first turn.',
  'usage.md':
    "Reika's modes (agent, plan, minimal, vibe, grind, chat, shell), headless runs for scripts and CI, slash commands and session transcripts.",
  'configuration.md':
    'Every REIKA_* setting: model profiles, context window, approvals, the macOS sandbox, web search, MCP servers and the experimental flags.',
  'tools.md':
    'The tools the Reika agent can call, from read, grep and edit to bash, web search and subagents, and when each one is registered.',
  'skills.md':
    'How Reika loads AGENTS.md instructions, turns Markdown skills into slash commands, and routes plain-English prompts to a skill.',
  'models.md':
    'Local quantized models and hosted API models Reika has been run against, with notes on what each one handled.',
  'platforms.md':
    'Running Reika on macOS, Linux and Windows (WSL): Node.js requirements, what differs per platform, and running on a weak machine.',
  'architecture.md':
    'How a Reika turn is put together: bootstrap, repo map, context management, prompt caching and what the harness does at each step.',
  'findings.md':
    'What running 8–35B models at Q2–Q4 on small context windows taught: what broke, what was tried and what held, with measurements.',
  'support.md':
    'Reika is free and open source under Apache-2.0. Ways to fund the project, contribute, and get in touch.',
};

export function canonicalUrl(relativePath: string): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
  return `${SITE_URL}/${path}`;
}

// Link previews on HN, Reddit, X and chat apps read these, not the meta description.
export function socialHead(pageData: PageData, title: string, description: string): HeadConfig[] {
  const url = canonicalUrl(pageData.relativePath);
  const image = `${SITE_URL}/social-preview.png`;
  return [
    ['link', { rel: 'canonical', href: url }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Reika' }],
    ['meta', { property: 'og:url', content: url }],
    ['meta', { property: 'og:title', content: title }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:image', content: image }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    [
      'meta',
      {
        property: 'og:image:alt',
        content: 'Reika, a coding agent CLI, editing a file in the terminal',
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: title }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: image }],
  ];
}

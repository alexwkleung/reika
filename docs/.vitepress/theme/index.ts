import type { Theme } from 'vitepress';
// The fontless entry drops the default theme's bundled Inter; the site's own faces load below.
import DefaultTheme from 'vitepress/theme-without-fonts';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { h } from 'vue';
import BlogIndex from './BlogIndex.vue';
import DemoToggle from './DemoToggle.vue';
import Landing from './Landing.vue';
import PostMeta from './PostMeta.vue';
import './style.css';

// The site's landing page is its own layout (`layout: Landing` in index.md) rather than the default
// theme's `home`, so its section order is ours. Everything it renders is exported by the default
// theme.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(PostMeta) }),
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('BlogIndex', BlogIndex);
    app.component('DemoToggle', DemoToggle);
  },
} satisfies Theme;

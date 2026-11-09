import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import BlogIndex from './BlogIndex.vue';
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
  },
} satisfies Theme;

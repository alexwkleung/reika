import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Landing from './Landing.vue';

// The site's landing page is its own layout (`layout: Landing` in index.md) rather than the default
// theme's `home`, so its section order is ours. Everything it renders is exported by the default
// theme.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
  },
} satisfies Theme;

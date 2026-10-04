<script setup lang="ts">
import { useData } from 'vitepress';
import { VPFeatures, VPHomeContent, VPHomeFeatures, VPHomeHero } from 'vitepress/theme';

// The landing page's sections, top to bottom: hero, then the markdown body (demo and quickstart),
// then the feature grid, then the doc links. index.md carries the copy; this file sets the order,
// out of the components the default theme exports, so the page keeps the default theme's look.
const { frontmatter, theme } = useData();
</script>

<template>
  <div class="Landing" :class="{ 'external-link-icon-enabled': theme.externalLinkIcon }">
    <VPHomeHero />
    <VPHomeContent>
      <Content />
    </VPHomeContent>
    <VPHomeFeatures />
    <VPFeatures v-if="frontmatter.next" class="LandingNext" :features="frontmatter.next" />
  </div>
</template>

<style scoped>
/* The default theme puts this gap on its own home layout; carried over so the last section does not
   run into the footer. Styling of the page itself is still the default theme's. */
.Landing {
  margin-bottom: 96px;
}

@media (min-width: 768px) {
  .Landing {
    margin-bottom: 128px;
  }
}

/* The hero's text column is centred as a block; the text inside it stays left-aligned. With no hero
   image the default hero grows that column to the whole 1152px container (its `flex-grow` overrides
   the two-thirds width), so the copy starts at the container's left edge. 576px is the width the
   theme itself caps the hero's copy at, so the column is exactly the text's measure. */
@media (min-width: 960px) {
  .Landing :deep(.VPHero .main) {
    margin: 0 auto;
    max-width: 576px;
  }
}
</style>

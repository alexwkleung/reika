<script setup lang="ts">
import VPFlyout from 'vitepress/dist/client/theme-default/components/VPFlyout.vue';
import VPMenuLink from 'vitepress/dist/client/theme-default/components/VPMenuLink.vue';
import { useTranslationLinks } from './translations';

const { currentLang, localeLinks, theme } = useTranslationLinks();
</script>

<template>
  <VPFlyout
    v-if="localeLinks.length && currentLang.label"
    class="VPNavBarTranslations"
    icon="vpi-languages"
    :label="theme.langMenuLabel || 'Change language'"
  >
    <div class="items">
      <p class="title">{{ currentLang.label }}</p>
      <VPMenuLink v-for="locale in localeLinks" :key="locale.link" :item="locale" />
    </div>
  </VPFlyout>
</template>

<style scoped>
.VPNavBarTranslations {
  display: none;
}

@media (min-width: 1280px) {
  .VPNavBarTranslations {
    display: flex;
    align-items: center;
  }
}

.title {
  padding: 0 24px 0 12px;
  line-height: 32px;
  font-size: 14px;
  font-weight: 700;
}
</style>

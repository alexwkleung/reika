<script setup lang="ts">
import VPFlyout from 'vitepress/dist/client/theme-default/components/VPFlyout.vue';
import VPMenuLink from 'vitepress/dist/client/theme-default/components/VPMenuLink.vue';
import VPSocialLinks from 'vitepress/dist/client/theme-default/components/VPSocialLinks.vue';
import { useTranslationLinks } from './translations';

const { currentLang, localeLinks, theme } = useTranslationLinks();
</script>

<template>
  <VPFlyout class="VPNavBarExtra" label="extra navigation">
    <div v-if="localeLinks.length && currentLang.label" class="group translations">
      <p class="title">{{ currentLang.label }}</p>
      <VPMenuLink v-for="locale in localeLinks" :key="locale.link" :item="locale" />
    </div>
    <div v-if="theme.socialLinks" class="group social-links">
      <VPSocialLinks :links="theme.socialLinks" />
    </div>
  </VPFlyout>
</template>

<style scoped>
.VPNavBarExtra {
  display: none;
  margin-right: -12px;
}

@media (min-width: 768px) and (max-width: 1279px) {
  .VPNavBarExtra {
    display: block;
  }
}

.title {
  padding: 0 24px 0 12px;
  line-height: 32px;
  font-size: 14px;
  font-weight: 700;
}

.group + .group {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--vp-c-divider);
}

.social-links {
  padding-right: 12px;
  padding-left: 12px;
}
</style>

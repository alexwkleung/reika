<script setup lang="ts">
import VPLink from 'vitepress/dist/client/theme-default/components/VPLink.vue';
import { ref } from 'vue';
import { useTranslationLinks } from './translations';

const { currentLang, localeLinks } = useTranslationLinks();
const isOpen = ref(false);
</script>

<template>
  <div
    v-if="localeLinks.length && currentLang.label"
    class="VPNavScreenTranslations"
    :class="{ open: isOpen }"
  >
    <button class="title" :aria-expanded="isOpen" @click="isOpen = !isOpen">
      <span class="vpi-languages icon" />
      {{ currentLang.label }}
      <span class="vpi-chevron-down icon" />
    </button>
    <ul v-if="isOpen" class="list">
      <li v-for="locale in localeLinks" :key="locale.link">
        <VPLink class="link" :href="locale.link">{{ locale.text }}</VPLink>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.title {
  display: flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
}

.icon {
  margin-right: 8px;
}

.list {
  padding: 4px 0 0 24px;
}

.link {
  line-height: 32px;
  font-size: 13px;
}
</style>

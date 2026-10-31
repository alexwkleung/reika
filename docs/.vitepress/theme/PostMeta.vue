<script setup lang="ts">
import { computed } from 'vue';
import { useData } from 'vitepress';
import { formatPostDate } from './postdate';

const { frontmatter, page } = useData();
// Page data reaches the client as JSON, so a YAML date is an ISO timestamp string by now.
const day = computed(() => String(frontmatter.value.date).slice(0, 10));
const isPost = computed(
  () => page.value.relativePath.startsWith('blog/') && frontmatter.value.date !== undefined,
);
</script>

<template>
  <div v-if="isPost" class="blog-meta post-meta">
    <a href="/blog/" class="post-back">← Blog</a>
    <time :datetime="day">{{ formatPostDate(day) }}</time>
    <span class="blog-kind">{{ frontmatter.kind }}</span>
    <span v-if="page.relativePath.includes('/drafts/')" class="blog-draft">draft</span>
  </div>
</template>

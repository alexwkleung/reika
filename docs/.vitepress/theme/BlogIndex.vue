<script setup lang="ts">
import { withBase } from 'vitepress';
import { data as posts } from '../../blog/posts.data';
import { formatPostDate } from './postdate';
</script>

<template>
  <p v-if="posts.length === 0" class="blog-empty">No posts yet.</p>
  <ul v-else class="blog-list">
    <li v-for="post in posts" :key="post.url" class="blog-item">
      <a :href="withBase(post.url)" class="blog-card">
        <div class="blog-meta">
          <time :datetime="post.date">{{ formatPostDate(post.date) }}</time>
          <span class="blog-kind">{{ post.kind }}</span>
          <span v-if="post.draft" class="blog-draft">draft</span>
        </div>
        <span class="blog-title">{{ post.title }}</span>
        <p class="blog-summary">{{ post.summary }}</p>
      </a>
    </li>
  </ul>
</template>

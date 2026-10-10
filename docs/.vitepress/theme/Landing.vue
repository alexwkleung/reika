<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import { VPHomeHero } from 'vitepress/theme';
import { computed } from 'vue';

// The landing page, top to bottom: the default theme's hero, then the markdown body (demo and
// install), then two plain sections drawn from the frontmatter — `features` as a short grid and
// `docs` as a link list. Those two are rendered here rather than with the default theme's feature
// cards, which made the page read as a wall of boxes.
type Item = { title: string; details: string; link?: string };
const { frontmatter } = useData();
const features = computed(() => (frontmatter.value.features ?? []) as Item[]);
const docs = computed(() => (frontmatter.value.docs ?? []) as Item[]);
</script>

<template>
  <div class="Landing">
    <VPHomeHero />

    <div class="LandingBody">
      <div class="vp-doc">
        <Content />
      </div>

      <section v-if="features.length" class="LandingSection">
        <h2>{{ frontmatter.featuresTitle }}</h2>
        <div class="LandingFeatures">
          <div v-for="item in features" :key="item.title" class="LandingFeature">
            <h3>{{ item.title }}</h3>
            <p>{{ item.details }}</p>
          </div>
        </div>
      </section>

      <section v-if="docs.length" class="LandingSection">
        <h2>{{ frontmatter.docsTitle }}</h2>
        <div class="LandingDocs">
          <a v-for="item in docs" :key="item.title" class="LandingDoc" :href="withBase(item.link!)">
            <span class="title">{{ item.title }}</span>
            <span class="details">{{ item.details }}</span>
          </a>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.Landing {
  margin-bottom: 96px;
}

/* The hero's column is the body's content width (960px less its 48px gutters), so the hero bar and
   every section below share one left edge. */
@media (min-width: 960px) {
  .Landing :deep(.VPHero .main) {
    margin: 0 auto;
    max-width: 864px;
  }
}

.LandingBody {
  margin: 0 auto;
  max-width: 960px;
  padding: 0 24px;
}

@media (min-width: 768px) {
  .LandingBody {
    padding: 0 48px;
  }
}

/* The markdown body's headings would get the doc pages' hover `#` link, which the sections drawn
   below have none of. */
.LandingBody :deep(.header-anchor) {
  display: none;
}

.LandingSection {
  margin-top: 72px;
}

.LandingSection h2 {
  margin: 0 0 24px;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.LandingFeatures {
  display: grid;
  gap: 28px 40px;
}

@media (min-width: 640px) {
  .LandingFeatures {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (min-width: 900px) {
  .LandingFeatures {
    grid-template-columns: repeat(3, 1fr);
  }
}

.LandingFeature h3 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
}

.LandingFeature p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.LandingDocs {
  display: grid;
  border-top: 1px solid var(--vp-c-divider);
}

@media (min-width: 640px) {
  .LandingDocs {
    grid-template-columns: repeat(2, 1fr);
    column-gap: 40px;
  }
}

.LandingDoc {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  text-decoration: none;
}

.LandingDoc .title {
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
}

.LandingDoc .details {
  font-size: 13px;
  color: var(--vp-c-text-3);
  text-align: right;
}

.LandingDoc:hover .title {
  color: var(--vp-c-brand-1);
}
</style>

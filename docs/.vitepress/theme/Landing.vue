<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import { computed } from 'vue';
import InstallBox from './InstallBox.vue';

// The landing page, top to bottom: the hero (name and headline beside the splash's ramp bar, the
// tagline, the install command, one button and a row of text links), then the markdown body (the
// demo), then two plain sections drawn from the frontmatter — `features` as a short grid and
// `docs` as a link list. All of it reads the page's frontmatter, so each language's landing is its
// own index.md.
type Item = { title: string; details: string; link?: string };
type Action = { theme: 'brand' | 'alt'; text: string; link: string };
type Hero = { name: string; text: string; tagline?: string; actions?: Action[] };
const { frontmatter } = useData();
const hero = computed(() => frontmatter.value.hero as Hero);
const primary = computed(() => hero.value.actions?.find(a => a.theme === 'brand'));
const links = computed(() => hero.value.actions?.filter(a => a.theme !== 'brand') ?? []);
const install = computed(() => frontmatter.value.install ?? []);
const features = computed(() => (frontmatter.value.features ?? []) as Item[]);
const docs = computed(() => (frontmatter.value.docs ?? []) as Item[]);
const external = (link: string) => /^https?:/.test(link);
</script>

<template>
  <div class="Landing">
    <div class="LandingBody">
      <section class="LandingHero">
        <h1 class="heading">
          <span class="name"><span aria-hidden="true">✿ </span>{{ hero.name }}</span>
          <span class="text">{{ hero.text }}</span>
        </h1>
        <p v-if="hero.tagline" class="tagline">{{ hero.tagline }}</p>
        <InstallBox
          v-if="install.length"
          class="install"
          :commands="install"
          :label="frontmatter.installLabel"
          :copy-label="frontmatter.copyLabel"
          :copied-label="frontmatter.copiedLabel"
        />
        <div class="actions">
          <a v-if="primary" class="primary" :href="withBase(primary.link)">{{ primary.text }}</a>
          <a
            v-for="a in links"
            :key="a.link"
            class="textlink"
            :href="external(a.link) ? a.link : withBase(a.link)"
            :target="external(a.link) ? '_blank' : undefined"
            :rel="external(a.link) ? 'noreferrer' : undefined"
            >{{ a.text }}
            <span class="arrow" aria-hidden="true">{{ external(a.link) ? '↗' : '→' }}</span></a
          >
        </div>
      </section>

      <div class="vp-doc">
        <Content />
      </div>

      <section v-if="features.length" class="LandingSection">
        <h2>{{ frontmatter.featuresTitle || 'What it does' }}</h2>
        <div class="LandingFeatures">
          <div v-for="item in features" :key="item.title" class="LandingFeature">
            <h3>{{ item.title }}</h3>
            <p>{{ item.details }}</p>
          </div>
        </div>
      </section>

      <section v-if="docs.length" class="LandingSection">
        <h2>{{ frontmatter.docsTitle || 'Documentation' }}</h2>
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

/* One column for the hero and every section, so they share a left edge; the nav is narrowed to the
   same column on this page (style.css). */
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

.LandingHero {
  padding: 64px 0 72px;
}

@media (min-width: 768px) {
  .LandingHero {
    padding-top: 104px;
  }
}

/* The ramp bar runs beside the name and headline only, at the proportions the splash draws it
   beside `✿ Reika`: a mark, not a border down the whole hero. The rest of the hero keeps the
   heading's indent so the column has one left edge. */
.heading {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
}

@media (min-width: 640px) {
  .LandingHero {
    padding-left: 27px;
  }

  .heading {
    position: relative;
  }

  .heading::before {
    content: '';
    position: absolute;
    top: 5px;
    bottom: 5px;
    left: -27px;
    width: 3px;
    border-radius: 2px;
    background: var(--reika-ramp);
  }
}

.name {
  font-size: 24px;
  line-height: 1.2;
  font-weight: 600;
  letter-spacing: -0.015em;
  color: var(--vp-c-brand-1);
}

.text {
  max-width: 720px;
  text-wrap: balance;
  white-space: pre-line;
  font-size: 34px;
  line-height: 1.12;
  font-weight: 600;
  letter-spacing: -0.025em;
  color: var(--vp-c-text-1);
}

@media (min-width: 768px) {
  .text {
    font-size: 46px;
  }
}

/* Balancing breaks Chinese between any two characters, splitting words (模 / 型), so the zh headline
   carries its own line break in the frontmatter (pre-line above) instead. */
:lang(zh) .text {
  text-wrap: wrap;
}

.tagline {
  max-width: 640px;
  margin: 18px 0 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

@media (min-width: 768px) {
  .tagline {
    font-size: 18px;
  }
}

.install {
  margin-top: 32px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 22px;
  margin-top: 24px;
  font-size: 14px;
}

.primary {
  display: inline-flex;
  align-items: center;
  height: 38px;
  padding: 0 16px;
  border-radius: 6px;
  background: var(--vp-button-brand-bg);
  color: #fff;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 0.2s;
}

.primary:hover {
  background: var(--vp-button-brand-hover-bg);
}

.primary:active {
  background: var(--vp-button-brand-active-bg);
}

/* The text links keep a button-sized hit area; the padding is taken back with a margin so the text
   sits where it would without it. */
.textlink {
  padding: 9px 4px;
  margin: 0 -4px;
  color: var(--vp-c-text-2);
  font-weight: 500;
  text-decoration: none;
  transition: color 0.2s;
}

.textlink:hover {
  color: var(--vp-c-text-1);
}

.primary:focus-visible,
.textlink:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
  border-radius: 6px;
}

/* The markdown body's headings would get the doc pages' hover `#` link, which the sections drawn
   below have none of. */
.LandingBody :deep(.header-anchor) {
  display: none;
}

.LandingSection {
  margin-top: 96px;
}

.LandingSection h2 {
  margin: 0 0 28px;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
}

.LandingFeatures {
  display: grid;
  gap: 32px 40px;
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
}

@media (min-width: 640px) {
  .LandingDocs {
    grid-template-columns: repeat(2, 1fr);
    column-gap: 40px;
  }
}

/* An index: each description follows its title, so a row reads as one entry rather than a label
   at each end of a gap. */
.LandingDoc {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 14px;
  padding: 12px 0;
  border-bottom: 1px solid var(--vp-c-divider);
  text-decoration: none;
}

/* A title never wraps; a description with no room beside it moves under it instead. */
.LandingDoc .title {
  flex: none;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-1);
  transition: color 0.2s;
}

.LandingDoc .details {
  font-size: 13px;
  color: var(--vp-c-text-3);
}

.LandingDoc:hover .title {
  color: var(--vp-c-brand-1);
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import terminalGif from '../../demo.gif';
import terminalPoster from '../../demo-poster.png';
import webGif from '../../demo-web.gif';
import webPoster from '../../demo-web-poster.png';

// The landing's demo: the terminal take and the web take of the same task, Terminal first. Both
// move (a still beside a moving clip reads as a mockup), and under prefers-reduced-motion each
// shows its poster, the take's last frame (scripts/demo-cut.sh). Text comes in as props so the zh
// landing passes its own.
const props = defineProps<{
  terminalLabel?: string;
  webLabel?: string;
  terminalAlt: string;
  webAlt: string;
  terminalCaption: string;
  webCaption: string;
}>();

type Side = 'terminal' | 'web';
const side = ref<Side>('terminal');
const sides = computed(() => [
  {
    id: 'terminal' as const,
    label: props.terminalLabel ?? 'Terminal',
    gif: terminalGif,
    poster: terminalPoster,
    alt: props.terminalAlt,
    caption: props.terminalCaption,
  },
  {
    id: 'web' as const,
    label: props.webLabel ?? 'Web',
    gif: webGif,
    poster: webPoster,
    alt: props.webAlt,
    caption: props.webCaption,
  },
]);

// The tablist pattern: arrows move between tabs, and only the selected one is in the tab order.
const tabs = ref<HTMLButtonElement[]>([]);
function onKey(e: KeyboardEvent, i: number): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next = (i + (e.key === 'ArrowRight' ? 1 : sides.value.length - 1)) % sides.value.length;
  side.value = sides.value[next]!.id;
  tabs.value[next]?.focus();
}
</script>

<template>
  <div class="DemoToggle">
    <div class="DemoTabs" role="tablist" aria-label="Demo">
      <button
        v-for="(s, i) in sides"
        :id="`demo-tab-${s.id}`"
        :key="s.id"
        ref="tabs"
        type="button"
        role="tab"
        class="DemoTab"
        :aria-selected="side === s.id"
        :aria-controls="`demo-panel-${s.id}`"
        :tabindex="side === s.id ? 0 : -1"
        @click="side = s.id"
        @keydown="onKey($event, i)"
      >
        {{ s.label }}
      </button>
    </div>
    <div
      v-for="s in sides"
      v-show="side === s.id"
      :id="`demo-panel-${s.id}`"
      :key="s.id"
      role="tabpanel"
      :aria-labelledby="`demo-tab-${s.id}`"
    >
      <picture>
        <source media="(prefers-reduced-motion: reduce)" :srcset="s.poster" />
        <img :src="s.gif" :alt="s.alt" width="1280" height="760" />
      </picture>
      <p class="DemoCaption">
        <sup>{{ s.caption }}</sup>
      </p>
    </div>
  </div>
</template>

<style scoped>
.DemoTabs {
  display: inline-flex;
  gap: 2px;
  margin-bottom: 12px;
  padding: 3px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}

.DemoTab {
  padding: 4px 14px;
  border-radius: 6px;
  color: var(--vp-c-text-2);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  transition:
    color 0.2s,
    background-color 0.2s;
}

.DemoTab:hover {
  color: var(--vp-c-text-1);
}

.DemoTab[aria-selected='true'] {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-shadow: 0 0 0 1px var(--vp-c-divider);
}

.DemoTab:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

img {
  display: block;
  width: 100%;
  height: auto;
}

.DemoCaption {
  margin: 8px 0 0;
}
</style>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
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
    poster: terminalPoster,
    alt: props.terminalAlt,
    caption: props.terminalCaption,
  },
  {
    id: 'web' as const,
    label: props.webLabel ?? 'Web',
    poster: webPoster,
    alt: props.webAlt,
    caption: props.webCaption,
  },
]);

// A clip restarts when its tab is picked, so it opens on the prompt rather than mid-turn. Chrome keeps
// one animation per image URL, so a new <img> or the same src does not restart it, and a query
// string re-downloads megabytes: each restart gets a fresh blob: URL of the cached bytes instead.
// The web gif is not fetched until its tab is first picked, and that first load needs no blob,
// since a gif loading for the first time starts at frame one.
const gifs: Record<Side, string> = { terminal: terminalGif, web: webGif };
const srcs = reactive<Record<Side, string | undefined>>({ terminal: terminalGif, web: undefined });
const blobs: Partial<Record<Side, Blob>> = {};
const restarts: Record<Side, number> = { terminal: 0, web: 0 };

async function restart(id: Side): Promise<void> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (srcs[id] === undefined) {
    srcs[id] = gifs[id];
    return;
  }
  const n = ++restarts[id];
  try {
    if (!blobs[id]) {
      const res = await fetch(gifs[id], { cache: 'force-cache' });
      if (!res.ok) return;
      blobs[id] = await res.blob();
    }
  } catch {
    return; // the clip keeps playing where it is, as it did before restarts
  }
  if (n !== restarts[id] || side.value !== id) return;
  const old = srcs[id];
  srcs[id] = URL.createObjectURL(blobs[id]!);
  if (old?.startsWith('blob:')) URL.revokeObjectURL(old);
}

function select(id: Side): void {
  if (side.value === id) return;
  side.value = id;
  void restart(id);
}

// The tablist pattern: arrows move between tabs, and only the selected one is in the tab order.
const tabs = ref<HTMLButtonElement[]>([]);
function onKey(e: KeyboardEvent, i: number): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next = (i + (e.key === 'ArrowRight' ? 1 : sides.value.length - 1)) % sides.value.length;
  select(sides.value[next]!.id);
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
        @click="select(s.id)"
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
        <img :src="srcs[s.id]" :alt="s.alt" width="1280" height="760" />
      </picture>
      <p class="DemoCaption">
        <sup>{{ s.caption }}</sup>
      </p>
    </div>
  </div>
</template>

<style scoped>
.DemoTabs {
  display: flex;
  gap: 4px;
  margin: 0 0 12px -10px;
}

/* Text tabs marked the way the install box above marks its own: the selected one underlined in
   orchid, the other lifting on hover, so the pair reads as a control rather than a caption. Each
   keeps a button-sized hit area; the row's negative margin takes the first tab's padding back so
   its text sits on the column edge. */
.DemoTab {
  position: relative;
  padding: 5px 10px;
  border-radius: 6px;
  color: var(--vp-c-text-3);
  font-size: 14px;
  font-weight: 500;
  line-height: 22px;
  transition:
    color 0.2s,
    background-color 0.2s;
}

.DemoTab:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--vp-c-text-1);
}

.DemoTab[aria-selected='true'] {
  background: transparent;
  color: var(--vp-c-text-1);
}

.DemoTab[aria-selected='true']::after {
  content: '';
  position: absolute;
  right: 10px;
  bottom: 0;
  left: 10px;
  height: 2px;
  border-radius: 1px;
  background: var(--vp-c-brand-1);
}

.DemoTab:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

/* The recordings sit in a quiet frame rather than floating on the page. Matched on the element, not
   the src: a restart swaps the src for a blob: URL. */
img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

.DemoCaption {
  margin: 8px 0 0;
}
</style>

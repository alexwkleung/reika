<script setup lang="ts">
import { ref } from 'vue';

// The landing hero's install command: one tab per package manager, the command, and a copy button.
// Commands come from the page's frontmatter so each language's landing carries its own.
type Command = { label: string; command: string };
const props = defineProps<{
  commands: Command[];
  label?: string;
  copyLabel?: string;
  copiedLabel?: string;
}>();

const picked = ref(0);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

// The tablist pattern, as DemoToggle has it: arrows move between tabs, and only the selected one
// is in the tab order.
const tabs = ref<HTMLButtonElement[]>([]);
function onKey(e: KeyboardEvent) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  e.preventDefault();
  const step = e.key === 'ArrowRight' ? 1 : -1;
  picked.value = (picked.value + step + props.commands.length) % props.commands.length;
  tabs.value[picked.value]?.focus();
}

async function copy() {
  try {
    await navigator.clipboard.writeText(props.commands[picked.value].command);
  } catch {
    return;
  }
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1600);
}
</script>

<template>
  <div class="InstallBox">
    <div class="InstallTabs" role="tablist" :aria-label="label ?? 'Install'" @keydown="onKey">
      <button
        v-for="(c, i) in commands"
        :id="`install-tab-${i}`"
        :key="c.label"
        ref="tabs"
        type="button"
        role="tab"
        class="InstallTab"
        :aria-selected="picked === i"
        :aria-controls="`install-panel`"
        :tabindex="picked === i ? 0 : -1"
        @click="picked = i"
      >
        {{ c.label }}
      </button>
    </div>
    <div
      id="install-panel"
      class="InstallPanel"
      role="tabpanel"
      :aria-labelledby="`install-tab-${picked}`"
    >
      <span class="prompt" aria-hidden="true">$</span>
      <code class="command">{{ commands[picked].command }}</code>
      <button
        type="button"
        class="InstallCopy"
        :aria-label="copied ? (copiedLabel ?? 'Copied') : (copyLabel ?? 'Copy command')"
        @click="copy"
      >
        <svg
          v-if="!copied"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" />
        </svg>
        <svg
          v-else
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>
      <span class="sr-only" aria-live="polite">{{ copied ? (copiedLabel ?? 'Copied') : '' }}</span>
    </div>
  </div>
</template>

<style scoped>
.InstallBox {
  max-width: 560px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-alt);
  font-family: var(--vp-font-family-mono);
}

/* Every tab is the same box, with the underline drawn as its bottom border over the row's rule, so
   the labels share one baseline whichever is selected. */
.InstallTabs {
  display: flex;
  gap: 4px;
  padding: 0 6px;
  border-bottom: 1px solid var(--vp-c-divider);
}

.InstallTab {
  display: flex;
  align-items: center;
  height: 36px;
  margin-bottom: -1px;
  padding: 0 8px;
  border-bottom: 2px solid transparent;
  color: var(--vp-c-text-3);
  font-size: 12px;
  transition: color 0.2s;
}

.InstallTab:hover {
  color: var(--vp-c-text-1);
}

.InstallTab[aria-selected='true'] {
  border-bottom-color: var(--vp-c-brand-1);
  color: var(--vp-c-text-1);
}

.InstallTab:focus-visible,
.InstallCopy:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
  border-radius: 4px;
}

.InstallPanel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px 10px 14px;
  font-size: 13px;
}

.prompt {
  color: var(--vp-c-text-3);
}

.command {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  color: var(--vp-c-text-1);
}

.InstallCopy {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--vp-c-text-3);
  transition:
    color 0.2s,
    background-color 0.2s;
}

.InstallCopy:hover {
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>

import { useData } from 'vitepress';
import type { DefaultTheme } from 'vitepress';
import { computed } from 'vue';
import { translationLink } from './translationLink';

export interface TranslationTheme extends DefaultTheme.Config {
  translatedPages?: string[];
}

export function useTranslationLinks() {
  const { site, page, localeIndex, theme } = useData<TranslationTheme>();
  const currentLang = computed(() => site.value.locales[localeIndex.value]);
  const localeLinks = computed(() =>
    Object.entries(site.value.locales)
      .filter(([locale]) => locale !== localeIndex.value)
      .map(([locale, config]) => ({
        text: config.label ?? locale,
        // Translated headings have different anchors, so start at the corresponding page's top.
        link: translationLink(page.value.relativePath, locale, theme.value.translatedPages ?? []),
      })),
  );
  return { currentLang, localeLinks, theme };
}

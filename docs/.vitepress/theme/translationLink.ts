export function translationLink(
  relativePath: string,
  locale: string,
  translatedPages: readonly string[],
): string {
  const page = relativePath.replace(/^zh\//, '').replace(/\.md$/, '');
  const home = locale === 'zh' ? '/zh/' : '/';
  return page !== 'index' && translatedPages.includes(page) ? home + page : home;
}

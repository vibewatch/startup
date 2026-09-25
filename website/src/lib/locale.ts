// Locale plumbing for the bilingual site. The English path is `/`
// (canonical), the Chinese mirror is `/zh/`. `localePath()` joins the
// Astro base URL, the locale prefix (empty for `en`), and extra
// segments so callers never assemble strings by hand.
export type Locale = 'en' | 'zh';

export const HTML_LANG: Record<Locale, string> = {
  en: 'en',
  zh: 'zh-CN',
};

export function localePrefix(locale: Locale): string {
  return locale === 'zh' ? 'zh/' : '';
}

// Joins base + (optional) locale + segments with exactly one separating slash
// at each boundary. Always emits a trailing slash to match astro.config
// `trailingSlash: 'always'`.
export function localePath(base: string, locale: Locale, ...segments: string[]): string {
  const trimmedBase = base.endsWith('/') ? base : `${base}/`;
  const parts = [trimmedBase, localePrefix(locale), ...segments]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  if (parts.length === 0) return '/';
  // The trimmed base lost its trailing slash above; reattach it as the
  // single leading slash of the assembled path.
  return `/${parts.join('/')}/`;
}

// Strips the trailing slash on file URLs (RSS, sitemap, search-index.json)
// where Astro emits the literal extension, not a directory.
export function localeFile(base: string, locale: Locale, fileName: string): string {
  const dir = localePath(base, locale).replace(/\/$/, '');
  return `${dir}/${fileName}`;
}

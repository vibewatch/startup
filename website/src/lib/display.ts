import type { Locale } from './locale';

// Localized labels for the small set of canonical enums emitted by the
// diligence schema. Anything not in this map (free-form text, prose, URLs,
// company names) passes through the generic title-case path below.
const ENUM_LABELS: Record<string, Record<Locale, string>> = {
  buy: { en: 'Buy', zh: '买入' },
  pass: { en: 'Pass', zh: '放弃' },
  track: { en: 'Track', zh: '观察' },
  avoid: { en: 'Avoid', zh: '回避' },
  'research-more': { en: 'Research more', zh: '继续研究' },
  high: { en: 'High', zh: '高' },
  medium: { en: 'Medium', zh: '中' },
  low: { en: 'Low', zh: '低' },
  unknown: { en: 'Unknown', zh: '未知' },
  stretched: { en: 'Stretched', zh: '偏高' },
  fair: { en: 'Fair', zh: '合理' },
  expensive: { en: 'Expensive', zh: '昂贵' },
  cheap: { en: 'Cheap', zh: '便宜' },
};

const BOOL_LABELS: Record<'true' | 'false', Record<Locale, string>> = {
  true: { en: 'Yes', zh: '是' },
  false: { en: 'No', zh: '否' },
};

const CELL_LABELS: Record<string, string> = {
  unknown: ENUM_LABELS.unknown.zh,
  none: '无',
  tbd: '待定',
};

// These complete-cell placeholders are preserved by the translation exporter.
export function displayCellText<T>(value: T, locale: Locale = 'en'): T | string {
  if (locale !== 'zh' || typeof value !== 'string') return value;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(CELL_LABELS, key) ? CELL_LABELS[key] : value;
}

export function displayLabel(value: unknown, locale: Locale = 'en'): string {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return BOOL_LABELS[value ? 'true' : 'false'][locale];
  if (typeof value !== 'string') return String(value);

  const trimmed = value.trim();
  if (!trimmed) return '';

  // Known enum: localize directly.
  const lookup = ENUM_LABELS[trimmed.toLowerCase()];
  if (lookup) return lookup[locale];

  // Transform compact identifiers/enums only. Leave prose, URLs, company names,
  // and mixed strings untouched. Title-casing only applies to the English
  // path; for zh, free-form strings are returned as-is (they are usually
  // proper nouns or already translated content).
  if (locale === 'en') {
    if (/^[a-z][A-Za-z0-9]*$/.test(trimmed) && /[A-Z]/.test(trimmed)) {
      return trimmed
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(trimmed)) return trimmed;
    return trimmed
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  return trimmed;
}

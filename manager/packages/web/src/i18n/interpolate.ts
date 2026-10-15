import { formatNumber } from './format';
import type { Locale } from './translations';

/**
 * Replaces all occurrences of `{count}` in `template` with `count` formatted
 * for the specified `locale` via `formatNumber`. If the template contains no
 * `{count}` placeholder, it is returned unchanged.
 */
export function interpolateCount(
  template: string,
  count: number,
  locale: Locale = 'en-US',
  options?: Intl.NumberFormatOptions,
): string {
  if (!template.includes('{count}')) {
    return template;
  }
  return template.replaceAll('{count}', formatNumber(count, locale, options));
}

/**
 * Generic string interpolation helper that replaces `{key}` placeholders with
 * provided parameter values. Numeric values are formatted via `formatNumber`.
 * Unmatched placeholders are preserved verbatim.
 */
export function interpolate(
  template: string,
  params: Record<string, string | number>,
  locale: Locale = 'en-US',
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (Object.hasOwn(params, key)) {
      const val = params[key];
      return typeof val === 'number' ? formatNumber(val, locale) : String(val);
    }
    return match;
  });
}

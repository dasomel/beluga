import type { Locale } from './translations';

const DEFAULT_DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

export function formatDateTime(
  value: Date | string | number,
  locale: Locale = 'en-US',
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return new Intl.DateTimeFormat(locale, options ?? DEFAULT_DATETIME_OPTIONS).format(date);
}

export function formatNumber(
  value: number,
  locale: Locale = 'en-US',
  options?: Intl.NumberFormatOptions,
): string {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return String(value);
  }
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatPercent(
  value: number,
  locale: Locale = 'en-US',
  options?: Intl.NumberFormatOptions,
): string {
  return formatNumber(value, locale, { style: 'percent', ...options });
}

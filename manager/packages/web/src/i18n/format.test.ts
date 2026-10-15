import { describe, expect, it } from 'vitest';
import { formatDateTime, formatNumber, formatPercent } from './format';

describe('formatDateTime', () => {
  const timestamp = '2026-09-23T10:18:00.000Z';
  const date = new Date(timestamp);

  it('formats dates with locale-specific patterns', () => {
    const formattedEn = formatDateTime(date, 'en-US', { timeZone: 'UTC' });
    const formattedKo = formatDateTime(date, 'ko-KR', { timeZone: 'UTC' });

    expect(formattedEn).toContain('9/23/2026');
    expect(formattedKo).toContain('2026. 9. 23.');
  });

  it('accepts string timestamp or epoch number', () => {
    const formattedStr = formatDateTime(timestamp, 'en-US', { timeZone: 'UTC' });
    const formattedNum = formatDateTime(date.getTime(), 'en-US', { timeZone: 'UTC' });

    expect(formattedStr).toBe(formattedNum);
  });

  it('falls back to string representation on invalid date input', () => {
    expect(formatDateTime('invalid-date', 'en-US')).toBe('invalid-date');
  });
});

describe('formatNumber', () => {
  it('formats integers and decimals according to locale', () => {
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
    expect(formatNumber(1234567, 'ko-KR')).toBe('1,234,567');
  });

  it('respects custom NumberFormatOptions', () => {
    expect(formatNumber(1234.56, 'en-US', { maximumFractionDigits: 1 })).toBe('1,234.6');
  });

  it('falls back to String(value) for non-numbers or NaN', () => {
    expect(formatNumber(NaN, 'en-US')).toBe('NaN');
  });
});

describe('formatPercent', () => {
  it('formats decimals into percent strings', () => {
    expect(formatPercent(0.95, 'en-US')).toBe('95%');
    expect(formatPercent(0.95, 'ko-KR')).toBe('95%');
  });
});

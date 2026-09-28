import { describe, expect, it } from 'vitest';
import { interpolate, interpolateCount } from './interpolate';

describe('interpolateCount', () => {
  describe('placeholder present', () => {
    it('formats count into English template', () => {
      expect(interpolateCount('{count} cols', 5, 'en-US')).toBe('5 cols');
    });

    it('formats count into Korean template without extra spacing', () => {
      expect(interpolateCount('{count}개 컬럼', 5, 'ko-KR')).toBe('5개 컬럼');
    });

    it('formats numbers with thousand separators according to locale', () => {
      expect(interpolateCount('{count} cols', 1234567, 'en-US')).toBe('1,234,567 cols');
      expect(interpolateCount('{count}개 컬럼', 1234567, 'ko-KR')).toBe('1,234,567개 컬럼');
    });

    it('handles zero and negative counts', () => {
      expect(interpolateCount('{count} cols', 0, 'en-US')).toBe('0 cols');
      expect(interpolateCount('{count}개 컬럼', 0, 'ko-KR')).toBe('0개 컬럼');
      expect(interpolateCount('{count} cols', -1, 'en-US')).toBe('-1 cols');
    });

    it('replaces multiple occurrences of {count}', () => {
      expect(interpolateCount('{count}/{count} items', 42, 'en-US')).toBe('42/42 items');
    });

    it('passes custom NumberFormatOptions', () => {
      expect(interpolateCount('{count} items', 1234.56, 'en-US', { maximumFractionDigits: 1 })).toBe(
        '1,234.6 items',
      );
    });

    it('defaults to en-US when locale is omitted', () => {
      expect(interpolateCount('{count} cols', 1000)).toBe('1,000 cols');
    });
  });

  describe('placeholder missing', () => {
    it('returns template unchanged for English missing {count}', () => {
      expect(interpolateCount('cols', 5, 'en-US')).toBe('cols');
    });

    it('returns template unchanged for Korean missing {count}', () => {
      expect(interpolateCount('개 컬럼', 5, 'ko-KR')).toBe('개 컬럼');
    });

    it('leaves unrelated placeholders untouched', () => {
      expect(interpolateCount('{total} items', 5, 'en-US')).toBe('{total} items');
    });
  });
});

describe('interpolate', () => {
  it('interpolates multiple params including formatted numbers', () => {
    const result = interpolate('{user} has {count} items', { user: 'Alice', count: 1200 }, 'en-US');
    expect(result).toBe('Alice has 1,200 items');
  });

  it('formats Korean parameters without unexpected whitespace', () => {
    const result = interpolate('{count}개 항목', { count: 3 }, 'ko-KR');
    expect(result).toBe('3개 항목');
  });

  it('leaves unmatched placeholders untouched', () => {
    const result = interpolate('{count} of {total}', { count: 5 }, 'en-US');
    expect(result).toBe('5 of {total}');
  });

  it('returns template unchanged when no placeholders exist', () => {
    expect(interpolate('plain text', { count: 5 }, 'en-US')).toBe('plain text');
  });

  it('defaults to en-US when locale is omitted', () => {
    expect(interpolate('{count}', { count: 1000 })).toBe('1,000');
  });
});

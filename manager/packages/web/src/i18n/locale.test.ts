import { describe, expect, it, vi } from 'vitest';
import { getInitialLocale, LOCALE_STORAGE_KEY, persistLocale } from './locale';

describe('locale preference', () => {
  it.each([
    ['ko-KR', 'ko-KR'],
    ['ko', 'ko-KR'],
    ['ko-KP', 'ko-KR'],
    ['KO-kr', 'ko-KR'],
    ['en-US', 'en-US'],
    ['en-GB', 'en-US'],
    ['en', 'en-US'],
    ['ja-JP', 'en-US'],
    ['korean', 'en-US'],
    ['', 'en-US'],
    [undefined, 'en-US'],
  ])('maps browser language %s to %s', (language, expected) => {
    expect(getInitialLocale({ navigator: { language } })).toBe(expected);
  });

  it('defaults to English without a browser', () => {
    expect(getInitialLocale({})).toBe('en-US');
  });

  it.each(['en-US', 'ko-KR'] as const)('restores manual selection %s over browser detection', (locale) => {
    const values = new Map<string, string>();
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    persistLocale(locale, { localStorage });

    expect(values.get(LOCALE_STORAGE_KEY)).toBe(locale);
    expect(getInitialLocale({
      navigator: { language: locale === 'en-US' ? 'ko-KR' : 'en-US' },
      localStorage,
    })).toBe(locale);
  });

  it.each([null, '', 'fr-FR', 'ko'])('ignores unsupported saved locale %s', (saved) => {
    const localStorage = { getItem: vi.fn().mockReturnValue(saved), setItem: vi.fn() };

    expect(getInitialLocale({ navigator: { language: 'ko-KR' }, localStorage })).toBe('ko-KR');
    expect(localStorage.getItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it('detects a locale and accepts a manual choice when storage access is blocked', () => {
    const environment = {
      navigator: { language: 'ko-KR' },
      get localStorage(): Storage {
        throw new Error('Storage access denied');
      },
    };

    expect(getInitialLocale(environment)).toBe('ko-KR');
    expect(() => persistLocale('en-US', environment)).not.toThrow();
  });
});

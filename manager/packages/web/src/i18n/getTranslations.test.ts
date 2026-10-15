import { describe, expect, it } from 'vitest';
import { getTranslations } from './getTranslations';
import { translations } from './translations';

function translationKeys(messages: object, prefix = ''): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? translationKeys(value, path) : [path];
  }).sort();
}

describe('translations', () => {
  it('keeps every en-US and ko-KR translation key in sync, including nested groups', () => {
    expect(translationKeys(translations['ko-KR'])).toEqual(translationKeys(translations['en-US']));
  });

  it.each(['en-US', 'ko-KR'] as const)('uses the selected %s messages', (locale) => {
    const t = getTranslations(locale);

    expect(t.nav.overview).toBe(translations[locale].nav.overview);
    expect(t.services.columns.name).toBe(translations[locale].services.columns.name);
    expect(t.appName).toBe('Beluga Manager');
  });

  it('falls back to English for a missing nested translation without mutating catalogs', () => {
    const catalogs = structuredClone(translations);
    Reflect.deleteProperty(catalogs['ko-KR'].services.columns, 'name');

    const t = getTranslations('ko-KR', catalogs);

    expect(t.services.columns.name).toBe(translations['en-US'].services.columns.name);
    expect(t.services.columns.status).toBe(translations['ko-KR'].services.columns.status);
    expect(Object.hasOwn(catalogs['ko-KR'].services.columns, 'name')).toBe(false);
  });

  it('falls back to English for a missing group', () => {
    const catalogs = structuredClone(translations);
    Reflect.deleteProperty(catalogs['ko-KR'], 'services');

    expect(getTranslations('ko-KR', catalogs).services.columns.name)
      .toBe(translations['en-US'].services.columns.name);
  });

  it.each(['en-US', 'ko-KR'] as const)('falls back to the full key when both %s and English lack it', (locale) => {
    const catalogs = structuredClone(translations);
    for (const catalog of Object.values(catalogs)) {
      Reflect.deleteProperty(catalog.services.columns, 'name');
      Reflect.deleteProperty(catalog, 'tagline');
    }

    const t = getTranslations(locale, catalogs);

    expect(t.services.columns.name).toBe('services.columns.name');
    expect(t.tagline).toBe('tagline');
  });
});

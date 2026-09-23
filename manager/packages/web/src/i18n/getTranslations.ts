import { translations, type Locale, type Translations } from './translations';

function isGroup(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

// D2: A lazy view preserves existing t.group.key consumers and resolves absent keys.
// The cost is a proxy per group read; replace this adapter if adopting an i18n library.
function withFallback<T extends object>(localized: object, english: T, prefix = ''): T {
  return new Proxy(english, {
    get(target, key, receiver) {
      if (typeof key !== 'string') return Reflect.get(target, key, receiver);

      const value = Object.hasOwn(localized, key) ? Reflect.get(localized, key) : undefined;
      const fallback = Object.hasOwn(target, key) ? Reflect.get(target, key) : undefined;
      const path = prefix ? `${prefix}.${key}` : key;

      if (isGroup(value) || isGroup(fallback)) {
        return withFallback(isGroup(value) ? value : {}, isGroup(fallback) ? fallback : {}, path);
      }
      return typeof value === 'string' ? value : typeof fallback === 'string' ? fallback : path;
    },
  });
}

export function getTranslations(
  locale: Locale,
  catalogs: Record<Locale, Translations> = translations,
): Translations {
  return withFallback(catalogs[locale] ?? {}, catalogs['en-US']);
}

import { readStoredValue, storeValue, type StorageEnvironment } from '../config/storage';
import type { Locale } from './translations';

export const LOCALE_STORAGE_KEY = 'beluga_locale';

interface LocaleEnvironment extends StorageEnvironment {
  navigator?: { language?: string };
}

export function getInitialLocale(environment: LocaleEnvironment): Locale {
  const saved = readStoredValue(LOCALE_STORAGE_KEY, environment);
  if (saved === 'en-US' || saved === 'ko-KR') {
    return saved;
  }

  const language = environment.navigator?.language?.toLowerCase().split('-')[0];
  return language === 'ko' ? 'ko-KR' : 'en-US';
}

export function persistLocale(locale: Locale, environment: StorageEnvironment): void {
  storeValue(LOCALE_STORAGE_KEY, locale, environment);
}

import { describe, expect, it, vi } from 'vitest';
import { readStoredValue, storeValue, type StorageEnvironment } from './storage';

describe('stored preferences', () => {
  it('reads and writes the requested preference', () => {
    const localStorage = {
      getItem: vi.fn().mockReturnValue('dark'),
      setItem: vi.fn(),
    };

    expect(readStoredValue('beluga_theme', { localStorage })).toBe('dark');
    expect(localStorage.getItem).toHaveBeenCalledExactlyOnceWith('beluga_theme');
    storeValue('beluga_theme', 'light', { localStorage });
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith('beluga_theme', 'light');
  });

  it('works without browser storage', () => {
    expect(readStoredValue('beluga_theme', {})).toBeNull();
    expect(() => storeValue('beluga_theme', 'dark', {})).not.toThrow();
  });

  it('handles a blocked localStorage getter', () => {
    const environment: StorageEnvironment = {
      get localStorage(): Storage {
        throw new Error('Storage access denied');
      },
    };

    expect(readStoredValue('beluga_theme', environment)).toBeNull();
    expect(() => storeValue('beluga_theme', 'dark', environment)).not.toThrow();
  });

  it('handles read failures and quota errors', () => {
    const localStorage = {
      getItem: vi.fn(() => { throw new Error('Read blocked'); }),
      setItem: vi.fn(() => { throw new Error('Quota exceeded'); }),
    };

    expect(readStoredValue('beluga_theme', { localStorage })).toBeNull();
    expect(() => storeValue('beluga_theme', 'dark', { localStorage })).not.toThrow();
  });
});

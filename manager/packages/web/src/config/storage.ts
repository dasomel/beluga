export interface StorageEnvironment {
  readonly localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
}

// D1: Storage access itself can throw. Keep preferences in memory on failure;
// persistence resumes on the next successful access, without another storage backend.
export function readStoredValue(key: string, environment: StorageEnvironment): string | null {
  try {
    return environment.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storeValue(key: string, value: string, environment: StorageEnvironment): void {
  try {
    environment.localStorage?.setItem(key, value);
  } catch {
    // The current session can still use the selected preference.
  }
}

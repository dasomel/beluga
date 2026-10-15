import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

type Status = 'new' | 'loading' | 'ok' | 'failed';

export interface RetryableLoader<P> {
  /** Current lazy component; its identity changes only on an accepted retry. */
  component: () => LazyExoticComponent<ComponentType<P>>;
  /** The exact function React.lazy calls to import (exposed so tests can drive it without a DOM). */
  load: () => Promise<{ default: ComponentType<P> }>;
  /** Swaps in a NEW lazy component (new import) only after a failure; false = refused (guard). */
  retry: () => boolean;
  stats: () => { attempt: number; importCalls: number; status: Status };
}

// D1: React.lazy caches a rejected promise forever, so a retry must create a new lazy component.
// The guard (retry only from the 'failed' state) means rapid repeated clicks cannot stack
// concurrent imports. importFn gets the attempt number so a caller can vary the request if it
// ever needs to; SqlEditor does not (a variable specifier would defeat Vite's static chunking).
export function createRetryableLoader<P>(
  importFn: (attempt: number) => Promise<{ default: ComponentType<P> }>,
): RetryableLoader<P> {
  let attempt = 0;
  let importCalls = 0;
  let status: Status = 'new';
  let current: LazyExoticComponent<ComponentType<P>>;

  const make = () => {
    const n = attempt;
    status = 'new';
    return lazy(() => load(n));
  };
  const load = (n = attempt) => {
    importCalls += 1;
    status = 'loading';
    return importFn(n).then(
      (m) => {
        status = 'ok';
        return m;
      },
      (e: unknown) => {
        status = 'failed';
        throw e;
      },
    );
  };
  current = make();

  return {
    component: () => current,
    load: () => load(),
    retry: () => {
      if (status !== 'failed') return false;
      attempt += 1;
      current = make();
      return true;
    },
    stats: () => ({ attempt, importCalls, status }),
  };
}

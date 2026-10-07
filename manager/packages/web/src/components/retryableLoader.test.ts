import type { ComponentType } from 'react';
import { describe, expect, it } from 'vitest';
import { createRetryableLoader } from './retryableLoader';

const Comp: ComponentType<object> = () => null;

// importFn that rejects `failures` times and then resolves; records every call.
function flaky(failures: number) {
  const calls: number[] = [];
  const importFn = (attempt: number) => {
    calls.push(attempt);
    return calls.length <= failures
      ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
      : Promise.resolve({ default: Comp });
  };
  return { importFn, calls };
}

describe('createRetryableLoader', () => {
  it('imports once on first load and reports ok', async () => {
    const { importFn, calls } = flaky(0);
    const l = createRetryableLoader(importFn);
    await expect(l.load()).resolves.toEqual({ default: Comp });
    expect(calls).toEqual([0]);
    expect(l.stats()).toEqual({ attempt: 0, importCalls: 1, status: 'ok' });
  });

  it('rejection -> retry creates a NEW component identity and a NEW import; success resets the error state', async () => {
    const { importFn, calls } = flaky(2);
    const l = createRetryableLoader(importFn);
    const first = l.component();

    await expect(l.load()).rejects.toThrow('dynamically imported');
    expect(l.stats().status).toBe('failed');
    expect(l.component()).toBe(first); // no retry yet: React.lazy would keep its cached rejection

    expect(l.retry()).toBe(true);
    const second = l.component();
    expect(second).not.toBe(first);
    await expect(l.load()).rejects.toThrow(); // second import also fails
    expect(l.retry()).toBe(true);
    expect(l.component()).not.toBe(second);
    await expect(l.load()).resolves.toEqual({ default: Comp });

    expect(calls).toEqual([0, 1, 2]); // one import per attempt, attempt number passed through
    expect(l.stats()).toEqual({ attempt: 2, importCalls: 3, status: 'ok' });
  });

  it('guards: retry is refused unless failed, so repeated calls cannot stack imports', async () => {
    const { importFn, calls } = flaky(1);
    const l = createRetryableLoader(importFn);
    expect(l.retry()).toBe(false); // new, nothing failed
    const pending = l.load();
    expect(l.retry()).toBe(false); // loading
    await expect(pending).rejects.toThrow();
    expect(l.retry()).toBe(true);
    const c = l.component();
    expect(l.retry()).toBe(false); // new lazy not yet loaded: a second click is a no-op
    expect(l.retry()).toBe(false);
    expect(l.component()).toBe(c);
    await l.load();
    expect(l.retry()).toBe(false); // ok
    expect(calls).toEqual([0, 1]);
  });

  it('keeps state per loader instance (a retry on one does not touch another)', async () => {
    const a = createRetryableLoader(flaky(1).importFn);
    const b = createRetryableLoader(flaky(0).importFn);
    const bComp = b.component();
    await expect(a.load()).rejects.toThrow();
    a.retry();
    expect(b.component()).toBe(bComp);
    expect(b.stats().attempt).toBe(0);
  });
});

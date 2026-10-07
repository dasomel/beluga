import { describe, expect, it } from 'vitest';
import {
  compareForDirection,
  createCollator,
  disclosureAction,
  sortValues,
  tanstackSortResult,
} from './dataTableSort';

const c = createCollator('en-US');

describe('sortValues', () => {
  const input = ['B', 'a', 'x', null, 'x'];
  it('ascending: case-insensitive primary order, nulls last', () => {
    expect(sortValues(input, false, c)).toEqual(['a', 'B', 'x', 'x', null]);
  });
  it('descending: reversed order but nulls still last', () => {
    expect(sortValues(input, true, c)).toEqual(['x', 'x', 'B', 'a', null]);
  });
  it('treats undefined and NaN as empty (last in both directions)', () => {
    expect(sortValues([undefined, 2, NaN, 1], false, c)).toEqual([1, 2, undefined, NaN]);
    expect(sortValues([undefined, 2, NaN, 1], true, c)).toEqual([2, 1, undefined, NaN]);
  });
  it('sorts numbers numerically, not lexically', () => {
    expect(sortValues([10, 9, 100, 1], false, c)).toEqual([1, 9, 10, 100]);
  });
  it('uses natural numeric order inside strings', () => {
    expect(sortValues(['file10', 'file2', 'file1'], false, c)).toEqual(['file1', 'file2', 'file10']);
  });
  it('is stable for ties (original order kept, in both directions)', () => {
    const rows = [{ k: 'a', i: 0 }, { k: 'A', i: 1 }, { k: 'a', i: 2 }];
    const strict = new Intl.Collator('en-US', { sensitivity: 'base' });
    expect(sortValues(rows.map((r) => ({ ...r })), false, strict).map((r) => r.i)).toEqual([0, 1, 2]);
    expect(sortValues(rows.map((r) => ({ ...r })), true, strict).map((r) => r.i)).toEqual([0, 1, 2]);
  });
  it('uses the locale collation (Korean: 가나다 order)', () => {
    const ko = createCollator('ko-KR');
    expect(sortValues(['다', '가', '나'], false, ko)).toEqual(['가', '나', '다']);
  });
  it('orders booleans, bigint and dates', () => {
    expect(sortValues([true, false], false, c)).toEqual([false, true]);
    expect(sortValues([3n, 1n, 2n], false, c)).toEqual([1n, 2n, 3n]);
    const d1 = new Date(2020, 1, 1);
    const d2 = new Date(2021, 1, 1);
    expect(sortValues([d2, d1], false, c)).toEqual([d1, d2]);
  });
});

describe('tanstackSortResult', () => {
  it('is pre-negated for desc so TanStack flipping it yields the final order', () => {
    expect(tanstackSortResult('a', 'b', false, c)).toBe(compareForDirection('a', 'b', false, c));
    expect(-tanstackSortResult('a', 'b', true, c)).toBe(compareForDirection('a', 'b', true, c));
    // null vs value: after TanStack's negation for desc, null still compares greater (last)
    expect(-tanstackSortResult(null, 'a', true, c)).toBeGreaterThan(0);
  });
});

describe('disclosureAction', () => {
  it('Escape closes and returns focus; other keys do nothing', () => {
    expect(disclosureAction({ type: 'key', key: 'Escape' })).toBe('close-and-refocus');
    expect(disclosureAction({ type: 'key', key: 'a' })).toBe('none');
  });
  it('outside pointer / focus leaving closes; inside does not', () => {
    expect(disclosureAction({ type: 'pointer', insidePanelOrButton: false })).toBe('close');
    expect(disclosureAction({ type: 'pointer', insidePanelOrButton: true })).toBe('none');
    expect(disclosureAction({ type: 'focusout', nextFocusInside: false })).toBe('close');
    expect(disclosureAction({ type: 'focusout', nextFocusInside: true })).toBe('none');
  });
});

// Pure sort/disclosure logic for DataTable, kept free of React/DOM so it is unit-tested directly.

export type CellValue = unknown;

// null, undefined and NaN are "empty": they always sort last, in both directions.
function isEmpty(v: CellValue): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
}

function comparable(v: CellValue): number | bigint | string {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return String(v);
}

export function createCollator(locale: string): Intl.Collator {
  // numeric: 'file2' < 'file10'; default sensitivity keeps case/accents as a tie-break, not as the primary key.
  return new Intl.Collator(locale, { numeric: true });
}

// Ascending order of two NON-empty values: numbers numerically, strings with the locale collator.
// Mixed number/string compares as strings, so the order stays total and deterministic.
export function compareNonEmpty(a: CellValue, b: CellValue, collator: Intl.Collator): number {
  const x = comparable(a);
  const y = comparable(b);
  if (typeof x !== 'string' && typeof y !== 'string') return x < y ? -1 : x > y ? 1 : 0;
  return collator.compare(String(x), String(y));
}

// Final order for the requested direction: empties last whichever way, ties return 0 so the
// (stable) caller keeps the original row order.
export function compareForDirection(
  a: CellValue,
  b: CellValue,
  desc: boolean,
  collator: Intl.Collator,
): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const r = compareNonEmpty(a, b, collator);
  return desc ? -r : r;
}

// TanStack Table negates a sortingFn result for descending sorts. Pre-negating here makes the
// net order equal compareForDirection(), which is what keeps empties last in both directions.
export function tanstackSortResult(
  a: CellValue,
  b: CellValue,
  desc: boolean,
  collator: Intl.Collator,
): number {
  const r = compareForDirection(a, b, desc, collator);
  return desc ? -r : r;
}

export function sortValues<T>(values: readonly T[], desc: boolean, collator: Intl.Collator): T[] {
  return values.map((v, i) => ({ v, i }))
    .sort((p, q) => compareForDirection(p.v, q.v, desc, collator) || p.i - q.i)
    .map((p) => p.v);
}

// Disclosure (column visibility panel) close rules.
export type DisclosureEvent =
  | { type: 'key'; key: string }
  | { type: 'pointer'; insidePanelOrButton: boolean }
  | { type: 'focusout'; nextFocusInside: boolean };

export function disclosureAction(e: DisclosureEvent): 'close-and-refocus' | 'close' | 'none' {
  if (e.type === 'key') return e.key === 'Escape' ? 'close-and-refocus' : 'none';
  if (e.type === 'pointer') return e.insidePanelOrButton ? 'none' : 'close';
  return e.nextFocusInside ? 'none' : 'close';
}

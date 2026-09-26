import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatViolation,
  partitionAgainstBaseline,
  scanDirectory,
  scanFixtures,
  scanSourceText,
  type BaselineEntry,
} from './hardcodedStringGuard';

describe('hardcodedStringGuard: positive cases (must flag)', () => {
  it('flags plain JSX text prose', () => {
    const violations = scanSourceText('Greeting.tsx', 'export const Greeting = () => <div>Hello there</div>;');
    expect(violations).toEqual([
      { file: 'Greeting.tsx', line: 1, column: 36, kind: 'jsx-text', text: 'Hello there' },
    ]);
  });

  it('flags a literal string rendered directly as a JSX child, e.g. <div>{"Hello"}</div>', () => {
    const violations = scanSourceText('Greeting.tsx', 'export const Greeting = () => <div>{"Hello there"}</div>;');
    expect(violations).toEqual([
      { file: 'Greeting.tsx', line: 1, column: 36, kind: 'jsx-text', text: 'Hello there' },
    ]);
  });

  it.each(['title', 'aria-label', 'placeholder', 'alt'])('flags the %s attribute', (attr) => {
    const violations = scanSourceText('Widget.tsx', `export const Widget = () => <input ${attr}="Save changes" />;`);
    expect(violations).toEqual([
      { file: 'Widget.tsx', line: 1, column: 36, kind: 'jsx-attribute', attribute: attr, text: 'Save changes' },
    ]);
  });

  it('flags a label-like prop by suffix, not just the literal name "label"', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <Service relatedServiceLabel="Trino Coordinator" />;',
    );
    expect(violations).toEqual([
      { file: 'Widget.tsx', line: 1, column: 38, kind: 'jsx-attribute', attribute: 'relatedServiceLabel', text: 'Trino Coordinator' },
    ]);
  });

  it('flags an attribute value given as a no-substitution template literal', () => {
    const violations = scanSourceText('Widget.tsx', 'export const Widget = () => <input title={`Save changes`} />;');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Save changes');
  });
});

describe('hardcodedStringGuard: negative cases (must not flag)', () => {
  it('ignores structural attributes even when their value has letters', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <a className="text-sm font-bold" data-testid="save-button" id="save" href="/save" />;',
    );
    expect(violations).toEqual([]);
  });

  it('ignores aria-* attributes other than aria-label', () => {
    const violations = scanSourceText('Widget.tsx', 'export const Widget = () => <div aria-hidden="true" aria-describedby="hint" />;');
    expect(violations).toEqual([]);
  });

  it('ignores text made only of punctuation, numbers, and HTML entity separators', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <span>42% &bull; 3.14 -- #001</span>;',
    );
    expect(violations).toEqual([]);
  });

  it('ignores whitespace-only JSX text between elements', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare function Icon(): null; '
        + 'export const Widget = () => (\n  <div>\n    <Icon />\n    <Icon />\n  </div>\n);',
    );
    expect(violations).toEqual([]);
  });

  it('ignores translation-call and API-provided expression children (not string literals)', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const t: { greeting: string }; declare const status: string; '
        + 'export const Widget = () => <div title={status}>{t.greeting}</div>;',
    );
    expect(violations).toEqual([]);
  });

  it('ignores a dynamic template literal (has a substitution, so it is not a literal)', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const name: string; export const Widget = () => <input title={`Hello ${name}`} />;',
    );
    expect(violations).toEqual([]);
  });
});

describe('hardcodedStringGuard: exemption mechanism', () => {
  it('exempts a JSX attribute literal via a trailing "i18n-exempt" comment', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input title="v0.1" // i18n-exempt: version badge, not prose\n/>;',
    );
    expect(violations).toEqual([]);
  });

  it('exempts a JSX attribute literal via a leading "i18n-exempt" comment', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input /* i18n-exempt: version badge */ title="v0.1" />;',
    );
    expect(violations).toEqual([]);
  });

  it('exempts a literal-string JSX child via an adjacent empty-expression comment sibling', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <div>{/* i18n-exempt: sample data */}{"Hello there"}</div>;',
    );
    expect(violations).toEqual([]);
  });

  it('exempts JSX text via an adjacent empty-expression comment sibling', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <div>{/* i18n-exempt: resource id, not prose */}Order Status</div>;',
    );
    expect(violations).toEqual([]);
  });

  it('still flags text when the exemption marker has no reason and records a generic reason downstream', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input title="Save changes" // not-an-exempt-marker\n/>;',
    );
    expect(violations).toHaveLength(1);
  });

  it('does not let an exemption comment on one attribute exempt an unrelated sibling attribute', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input /* i18n-exempt: ok */ id="x" title="Needs translation" />;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Needs translation');
  });
});

describe('hardcodedStringGuard: multi-file scanning', () => {
  it('reports violations across multiple fixtures, tagged with their own file path', () => {
    const violations = scanFixtures([
      { file: 'positive/Greeting.tsx', text: 'export const Greeting = () => <div>Hello</div>;' },
      { file: 'negative/Icon.tsx', text: 'export const Icon = () => <svg className="h-4 w-4" data-testid="icon" />;' },
    ]);
    expect(violations).toEqual([
      { file: 'positive/Greeting.tsx', line: 1, column: 36, kind: 'jsx-text', text: 'Hello' },
    ]);
  });
});

describe('hardcodedStringGuard: baseline partitioning', () => {
  const violation = { file: 'src/App.tsx', line: 1, column: 1, kind: 'jsx-text' as const, text: 'v0.1' };

  it('routes a violation matching a reviewed baseline entry to "baselined", not "blocking"', () => {
    const baseline: BaselineEntry[] = [{ file: 'src/App.tsx', line: 1, text: 'v0.1', reason: 'version badge' }];
    const { blocking, baselined } = partitionAgainstBaseline([violation], baseline);
    expect(blocking).toEqual([]);
    expect(baselined).toEqual([violation]);
  });

  it('treats an unlisted violation as blocking', () => {
    const { blocking, baselined } = partitionAgainstBaseline([violation], []);
    expect(blocking).toEqual([violation]);
    expect(baselined).toEqual([]);
  });

  it('formats a violation for a readable failure message', () => {
    expect(formatViolation(violation)).toBe('src/App.tsx:1:1 -> "v0.1"');
    expect(formatViolation({ ...violation, kind: 'jsx-attribute', attribute: 'title' }))
      .toBe('src/App.tsx:1:1 [title] -> "v0.1"');
  });
});

describe('hardcodedStringGuard: CI gate on packages/web/src', () => {
  // This is the actual gate for issue #44: every non-test .tsx file under packages/web/src is
  // scanned through the real project (so JSX/tsconfig settings match the real build), and any
  // hardcoded user-facing string that is not in the reviewed baseline fails this test -- which
  // `npm test` (and therefore CI's "Typecheck and Tests" job) already runs on every push and PR.
  it('has no unbaselined hardcoded user-facing strings', () => {
    const srcDir = join(import.meta.dirname, '..');
    const baselinePath = join(import.meta.dirname, 'hardcodedStringGuard.baseline.json');
    const baseline: BaselineEntry[] = JSON.parse(readFileSync(baselinePath, 'utf8'));

    const violations = scanDirectory(srcDir);
    const { blocking, baselined } = partitionAgainstBaseline(violations, baseline);

    if (blocking.length > 0) {
      throw new Error(
        `${blocking.length} new hardcoded user-facing string(s) found. Route them through the `
          + `translation catalogs (src/i18n/translations.ts), mark them exempt with an inline `
          + `"i18n-exempt: <reason>" comment, or add a reviewed entry with a reason to `
          + `hardcodedStringGuard.baseline.json:\n${blocking.map(formatViolation).join('\n')}`,
      );
    }

    // Every baseline entry should correspond to a real violation still present in the source;
    // an entry with nothing left to match is stale and should be deleted.
    expect(baselined.length).toBe(baseline.length);
  });
});

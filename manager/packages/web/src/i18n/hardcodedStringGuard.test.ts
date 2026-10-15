import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatViolation,
  listTsxFiles,
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

  // Regression coverage for a code-review finding on issue #44: only JSX expressions that were
  // *entirely* a string literal were inspected, so a literal reached through a conditional,
  // logical/nullish fallback, parentheses, an array literal, or a template literal's static
  // text escaped detection entirely. These wrappers are now recursed into (see
  // `resolveTranslatableLiterals`), while calls/identifiers/property access still stop the walk.
  it('flags both branches of a ternary rendered as a JSX child, e.g. {ready ? "Saved" : "Saving"}', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const ready: boolean; export const Widget = () => <div>{ready ? "Saved" : "Saving"}</div>;',
    );
    expect(violations.map((v) => v.text).sort()).toEqual(['Saved', 'Saving']);
    expect(violations.every((v) => v.kind === 'jsx-text')).toBe(true);
  });

  it('flags the right-hand literal of a logical AND rendered as a JSX child, e.g. {a && "Text"}', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const show: boolean; export const Widget = () => <div>{show && "Text"}</div>;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Text');
  });

  it('flags the fallback literal of a nullish-coalescing expression, e.g. {x ?? "Fallback"}', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const x: string | undefined; export const Widget = () => <div>{x ?? "Fallback"}</div>;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Fallback');
  });

  it('flags the fallback literal of a logical OR expression, e.g. {x || "Fallback text"}', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const x: string; export const Widget = () => <div>{x || "Fallback text"}</div>;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Fallback text');
  });

  it('flags the static text of a template literal with a substitution, e.g. `Saved ${count} items`', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const count: number; export const Widget = () => <div>{`Saved ${count} items`}</div>;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Saved  items');
  });

  it('flags string literals inside an array literal rendered as JSX children', () => {
    const violations = scanSourceText('Widget.tsx', 'export const Widget = () => <div>{["Save", "Cancel"]}</div>;');
    expect(violations.map((v) => v.text).sort()).toEqual(['Cancel', 'Save']);
  });

  it('flags both branches of a ternary in a parenthesized expression rendered as a JSX child', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const ready: boolean; export const Widget = () => <div>{(ready ? "Saved" : "Saving")}</div>;',
    );
    expect(violations.map((v) => v.text).sort()).toEqual(['Saved', 'Saving']);
  });

  it('flags both branches of a ternary in a user-facing attribute', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const saving: boolean; export const Widget = () => <input title={saving ? "Saving" : "Save"} />;',
    );
    expect(violations.map((v) => v.text).sort()).toEqual(['Save', 'Saving']);
    expect(violations.every((v) => v.kind === 'jsx-attribute' && v.attribute === 'title')).toBe(true);
  });

  it('does not descend into a function-call branch, but still flags a sibling literal branch', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare function save(): string; declare const ready: boolean; '
        + 'export const Widget = () => <div>{ready ? save() : "Saving"}</div>;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Saving');
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

  it('ignores a template literal whose only content is interpolation (no static prose)', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const name: string; export const Widget = () => <input title={`${name}`} />;',
    );
    expect(violations).toEqual([]);
  });

  // Was previously (incorrectly) treated as a negative case: a template literal *with* a
  // substitution still renders its static text verbatim around the interpolated value, so
  // `` `Hello ${name}` `` renders hardcoded "Hello " prose regardless of what `name` is. See
  // the "flags the static text of a template literal with a substitution" positive-case test.
  it('flags the static text of a template literal used as an attribute value, e.g. `Hello ${name}`', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'declare const name: string; export const Widget = () => <input title={`Hello ${name}`} />;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: 'jsx-attribute', attribute: 'title', text: 'Hello' });
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
      'export const Widget = () => <input /* i18n-exempt: not user-facing */ id="x" title="Needs translation" />;',
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.text).toBe('Needs translation');
  });

  // Regression coverage for a code-review finding on issue #44: a bare "i18n-exempt" marker
  // (or one with a token reason like "ok") silently exempted its target while emitting a
  // fabricated generic reason downstream -- i.e. it looked reviewed but was not. A marker now
  // needs a real reason (>= 8 chars) to exempt anything, and a marker that doesn't clear that
  // bar is itself reported as a violation (kind `invalid-exempt-marker`) so the misuse is
  // visible in the gate's own output instead of being invisible.
  it('does not let a bare "i18n-exempt" marker (no reason) exempt anything, and flags the marker itself', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input title="Save changes" // i18n-exempt\n/>;',
    );
    expect(violations).toHaveLength(2);
    const marker = violations.find((v) => v.kind === 'invalid-exempt-marker');
    const attr = violations.find((v) => v.kind === 'jsx-attribute');
    expect(marker?.text).toBe('// i18n-exempt');
    expect(attr?.text).toBe('Save changes');
  });

  it('does not let an "i18n-exempt" marker with a too-short reason exempt anything, and flags the marker itself', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input title="Save changes" // i18n-exempt: short\n/>;',
    );
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.kind === 'invalid-exempt-marker' && v.text === '// i18n-exempt: short')).toBe(true);
    expect(violations.some((v) => v.kind === 'jsx-attribute' && v.text === 'Save changes')).toBe(true);
  });

  it('lets an "i18n-exempt" marker with a reason at the minimum length (8 chars) exempt, and does not flag the marker', () => {
    const violations = scanSourceText(
      'Widget.tsx',
      'export const Widget = () => <input title="Save changes" // i18n-exempt: 12345678\n/>;',
    );
    expect(violations).toEqual([]);
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
    expect(formatViolation({ ...violation, kind: 'invalid-exempt-marker', text: '// i18n-exempt' }))
      .toBe('src/App.tsx:1:1 [invalid i18n-exempt marker] -> "// i18n-exempt"');
  });
});

describe('hardcodedStringGuard: fails closed on files it cannot parse', () => {
  // Regression coverage for a code-review finding on issue #44: a file the native project
  // couldn't produce a `SourceFile` for was silently skipped (an empty result, not a warning),
  // so the gate could stop checking a file without anyone noticing. Both scan entry points now
  // throw with the offending path instead.
  it('scanFixtures throws with the file path instead of silently returning no violations', () => {
    // A leading slash in the fixture path makes the requested absolute path diverge from the
    // one actually opened in the project snapshot, which is exactly the kind of mismatch that
    // previously produced a silent `undefined` SourceFile.
    expect(() => scanFixtures([{ file: '/Unreachable.tsx', text: 'export const X = () => <div>Hello</div>;' }]))
      .toThrow(/failed to parse fixture "\/Unreachable\.tsx"/);
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

    // Independently confirm every discovered file was actually scanned -- not just that
    // `scanDirectory` completed without throwing -- so a future regression that reintroduces a
    // silent per-file skip (e.g. swallowing the fail-closed error) is caught by this count
    // matching, not only by the fail-closed throw itself.
    const discoveredFiles = listTsxFiles(srcDir);
    const { violations, fileCount } = scanDirectory(srcDir);
    expect(fileCount).toBe(discoveredFiles.length);

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

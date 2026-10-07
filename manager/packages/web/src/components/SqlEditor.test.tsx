import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { sql } from '@codemirror/lang-sql';
import { highlightTree } from '@lezer/highlight';
import { SqlEditor, type SqlEditorProps } from './SqlEditor';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import {
  EDITOR_PALETTES,
  contrastRatio,
  editorContentAttributes,
  editorThemeExtensions,
  highlightStyleFor,
} from './sqlEditorTheme';

const sampleSql = 'SELECT id, 42 AS n, \'x\' FROM "beluga_lake"."analytics"."orders" -- note\nLIMIT 20;';

const baseProps: SqlEditorProps = {
  value: sampleSql,
  theme: 'light',
  label: 'Trino starter SQL editor',
  loadingLabel: 'Loading SQL editor...',
  loadFailedLabel: 'Editor failed to load',
  retryLabel: 'Retry',
  title: 'Trino Starter SQL',
  readOnlyBadgeLabel: 'Read-only starter SQL',
  copyLabel: 'Copy SQL',
  copiedLabel: 'Copied',
  copyFailedLabel: 'Copy failed',
};

// What these tests cover: pure functions (palettes, contrast, highlight style, attributes) and the
// server-rendered markup. What they do NOT cover: the live CodeMirror DOM (Compartment
// reconfigure on toggle, real focus/Tab behaviour, copy in a browser, screen readers).
describe('SqlEditor markup (SSR)', () => {
  it('renders the statement, title, badge and copy button; the content is a focusable named read-only textbox', () => {
    const html = renderToStaticMarkup(<SqlEditor {...baseProps} />);
    expect(html).toContain('Trino Starter SQL');
    expect(html).toContain('Read-only starter SQL');
    expect(html).toContain('Copy SQL');
    expect(html).toContain('&quot;beluga_lake&quot;');
    expect(html).toContain('role="textbox"');
    expect(html).toContain('aria-readonly="true"');
    expect(html).toContain('aria-multiline="true"');
    expect(html).toContain('aria-label="Trino starter SQL editor"');
    expect(html).toContain('tabindex="0"');
  });

  it('has a status live region for the copy outcome and no execution or textarea controls', () => {
    const html = renderToStaticMarkup(<SqlEditor {...baseProps} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Run Query');
    expect(html).not.toContain('Execute');
    expect(html).not.toContain('<textarea');
  });

  it('exposes the theme it was given (the app theme, both ways)', () => {
    expect(renderToStaticMarkup(<SqlEditor {...baseProps} theme="dark" />)).toContain('data-theme="dark"');
    expect(renderToStaticMarkup(<SqlEditor {...baseProps} theme="light" />)).toContain('data-theme="light"');
  });

  it('renders extra actions', () => {
    const html = renderToStaticMarkup(
      <SqlEditor {...baseProps} extraActions={<span id="test-action">Extra Link</span>} />,
    );
    expect(html).toContain('id="test-action"');
  });
});

describe('editorContentAttributes', () => {
  it('makes read-only content focusable, named and marked read-only multiline', () => {
    expect(editorContentAttributes('Name')).toEqual({
      role: 'textbox',
      'aria-readonly': 'true',
      'aria-multiline': 'true',
      'aria-label': 'Name',
      tabindex: '0',
    });
  });
});

describe.each(['light', 'dark'] as const)('%s theme', (theme) => {
  const parse = () => sql().language.parser.parse(sampleSql);

  it('highlights SQL (keywords, strings, numbers, comments get a style class)', () => {
    const classes = new Set<string>();
    let count = 0;
    highlightTree(parse(), highlightStyleFor(theme), (_from, _to, cls) => {
      count += 1;
      classes.add(cls);
    });
    expect(count).toBeGreaterThanOrEqual(8);
    expect(classes.size).toBeGreaterThanOrEqual(4);
  });

  it('builds a valid editor state with the theme extensions', () => {
    const state = EditorState.create({ doc: sampleSql, extensions: [sql(), editorThemeExtensions(theme)] });
    expect(state.doc.toString()).toBe(sampleSql);
  });

  it('every text colour meets 4.5:1 against its actual background', () => {
    const p = EDITOR_PALETTES[theme];
    const pairs: Array<[string, string, string]> = [
      ['text', p.text, p.background],
      ['gutterText', p.gutterText, p.gutterBackground],
      ['gutterText on active line', p.gutterText, p.activeLineGutter],
      ...(['keyword', 'string', 'number', 'comment', 'operator', 'type', 'literal'] as const).map(
        (k): [string, string, string] => [k, p[k], p.background],
      ),
    ];
    for (const [name, fg, bg] of pairs) {
      expect(contrastRatio(fg, bg), `${theme} ${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('contrastRatio', () => {
  it('matches known values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#94a3b8', '#f8fafc')).toBeLessThan(3); // the old light gutter (2.45:1)
  });
});

describe('ChunkErrorBoundary', () => {
  const props = {
    value: sampleSql,
    label: 'Trino starter SQL editor',
    failedLabel: 'Editor failed to load',
    retryLabel: 'Retry',
    onRetry: () => {},
    children: <span>live editor</span>,
  };

  it('turns a render/chunk error into failed state', () => {
    expect(ChunkErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it('renders children while healthy', () => {
    const b = new ChunkErrorBoundary(props);
    expect(renderToStaticMarkup(<>{b.render()}</>)).toContain('live editor');
  });

  it('after a failure renders the plain copyable SQL, a status message and a retry button', () => {
    const b = new ChunkErrorBoundary(props);
    b.state = { failed: true };
    const html = renderToStaticMarkup(<>{b.render()}</>);
    expect(html).not.toContain('live editor');
    expect(html).toContain('role="status"');
    expect(html).toContain('Editor failed to load');
    expect(html).toContain('Retry');
    expect(html).toContain('&quot;beluga_lake&quot;');
    expect(html).toContain('aria-label="Trino starter SQL editor"');
  });
});

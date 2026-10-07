import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export type EditorTheme = 'light' | 'dark';

// D1: every colour lives here as a literal hex so the contrast test can compute real ratios
// (WCAG 1.4.3 needs 4.5:1 for text). Escape hatch: if a token fails the test, change only this table.
export interface EditorPalette {
  background: string;
  text: string;
  gutterBackground: string;
  gutterText: string;
  gutterBorder: string;
  activeLineGutter: string;
  keyword: string;
  string: string;
  number: string;
  comment: string;
  operator: string;
  type: string;
  literal: string;
}

export const EDITOR_PALETTES: Record<EditorTheme, EditorPalette> = {
  light: {
    background: '#ffffff',
    text: '#0f172a',
    gutterBackground: '#f8fafc',
    gutterText: '#475569',
    gutterBorder: '#e2e8f0',
    activeLineGutter: '#f1f5f9',
    keyword: '#7e22ce',
    string: '#15803d',
    number: '#b45309',
    comment: '#475569',
    operator: '#334155',
    type: '#0369a1',
    literal: '#be123c',
  },
  dark: {
    background: '#020617',
    text: '#67e8f9',
    gutterBackground: '#020617',
    gutterText: '#94a3b8',
    gutterBorder: '#1e293b',
    activeLineGutter: '#0f172a',
    keyword: '#f0abfc',
    string: '#86efac',
    number: '#fdba74',
    comment: '#94a3b8',
    operator: '#cbd5e1',
    type: '#7dd3fc',
    literal: '#fda4af',
  },
};

export function highlightStyleFor(theme: EditorTheme): HighlightStyle {
  const p = EDITOR_PALETTES[theme];
  return HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: p.keyword, fontWeight: 'bold' },
    { tag: [t.string, t.special(t.string)], color: p.string },
    { tag: [t.number, t.integer, t.float], color: p.number },
    { tag: [t.comment, t.lineComment, t.blockComment], color: p.comment, fontStyle: 'italic' },
    { tag: [t.operator, t.punctuation, t.separator, t.paren], color: p.operator },
    { tag: [t.typeName, t.standard(t.name)], color: p.type },
    { tag: [t.bool, t.null, t.atom], color: p.literal },
  ]);
}

export function editorThemeExtensions(theme: EditorTheme): Extension[] {
  const p = EDITOR_PALETTES[theme];
  return [
    EditorView.theme(
      {
        '&': {
          height: '100%',
          fontSize: '12px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          backgroundColor: p.background,
          color: p.text,
        },
        '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
        '.cm-content': { padding: '12px 0' },
        '.cm-line': { padding: '0 12px' },
        '.cm-gutters': {
          backgroundColor: p.gutterBackground,
          borderRight: `1px solid ${p.gutterBorder}`,
          color: p.gutterText,
          fontSize: '11px',
        },
        '.cm-activeLineGutter': { backgroundColor: p.activeLineGutter },
      },
      { dark: theme === 'dark' },
    ),
    syntaxHighlighting(highlightStyleFor(theme)),
  ];
}

// WCAG 2.x relative luminance / contrast ratio of two #rrggbb colours.
function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Attributes for the editor's content element. The read-only editor is rendered with
// contenteditable=false, which browsers do not put in the tab order, so tabindex=0 is required for
// keyboard users to focus, scroll, select and copy. D2: Tab is never captured (no indentWithTab
// and no keymap binding Tab), so there is no keyboard trap (WCAG 2.1.2) and no Escape-then-Tab
// escape is needed; there is intentionally no editable mode.
export function editorContentAttributes(label: string): Record<string, string> {
  return {
    role: 'textbox',
    'aria-readonly': 'true',
    'aria-multiline': 'true',
    'aria-label': label,
    tabindex: '0',
  };
}

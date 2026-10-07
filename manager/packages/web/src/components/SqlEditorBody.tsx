import React, { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { sql } from '@codemirror/lang-sql';
import { EditorTheme, editorContentAttributes, editorThemeExtensions } from './sqlEditorTheme';

export interface SqlEditorBodyProps {
  value: string;
  theme: EditorTheme;
  label: string;
}

// D1: CodeMirror 6 (MIT, ADR-0003). This module is the only importer of the CodeMirror packages
// and is loaded through React.lazy by SqlEditor, so its ~350 kB lives in an async chunk.
// The theme sits in a Compartment so a light/dark toggle reconfigures the live view.
// Browser-only DOM glue; the logic it relies on (palettes, attributes) is tested as pure functions.
const SqlEditorBody: React.FC<SqlEditorBodyProps> = ({ value, theme, label }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const attrsCompartment = useRef(new Compartment());
  // Latest values for the one-time view creation, without re-creating the view on every change.
  const initial = useRef({ value, theme, label });
  initial.current = { value, theme, label };

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          lineNumbers(),
          sql(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          attrsCompartment.current.of(EditorView.contentAttributes.of(editorContentAttributes(initial.current.label))),
          themeCompartment.current.of(editorThemeExtensions(initial.current.theme)),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Label changes (e.g. locale switch) reconfigure only the attributes: no view rebuild, scroll/selection kept.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: attrsCompartment.current.reconfigure(
        EditorView.contentAttributes.of(editorContentAttributes(label)),
      ),
    });
  }, [label]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(editorThemeExtensions(theme)),
    });
  }, [theme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (currentDoc !== value) {
      view.dispatch({ changes: { from: 0, to: currentDoc.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className="min-h-[120px]" />;
};

export default SqlEditorBody;

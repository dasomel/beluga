import React from 'react';

// Plain, focusable rendering of the SQL. Shown on the server, before CodeMirror mounts and while
// the lazy editor chunk loads, so the statement is readable and copyable without the heavy chunk.
export const SqlStatic: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <pre
    role="textbox"
    aria-readonly="true"
    aria-multiline="true"
    aria-label={label}
    tabIndex={0}
    className="bg-slate-50 dark:bg-slate-950 p-4 text-xs font-mono text-slate-900 dark:text-cyan-300 overflow-x-auto leading-relaxed whitespace-pre-wrap focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500 focus-visible:ring-inset"
  >
    <code>{value}</code>
  </pre>
);

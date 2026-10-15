import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Check, Copy, Lock, Terminal } from 'lucide-react';
import { copyToClipboard } from './clipboard';
import { SqlStatic } from './SqlStatic';
import { ChunkErrorBoundary } from './ChunkErrorBoundary';
import type { EditorTheme } from './sqlEditorTheme';
import { createRetryableLoader } from './retryableLoader';
import type { SqlEditorBodyProps } from './SqlEditorBody';

// Heavy part (CodeMirror) is an async chunk: only views that render a SQL editor pay for it.
const newBodyLoader = () =>
  createRetryableLoader<SqlEditorBodyProps>(() => import('./SqlEditorBody'));
// Shared while healthy (no re-suspend per mount). A retry gives only the retrying instance its own
// loader (D2), so a retry here never remounts a healthy editor elsewhere.
const sharedBodyLoader = newBodyLoader();

export interface SqlEditorProps {
  value: string;
  /** Must follow the app theme; the editor reconfigures when it changes. */
  theme: EditorTheme;
  /** Accessible name of the editor content (textbox) -- required, never empty. */
  label: string;
  /** Announced and shown while the editor chunk loads. */
  loadingLabel: string;
  /** Shown (with the plain SQL) when the editor chunk fails to load. */
  loadFailedLabel: string;
  retryLabel: string;
  title?: string;
  readOnlyBadgeLabel?: string;
  copyLabel: string;
  copiedLabel: string;
  copyFailedLabel: string;
  className?: string;
  extraActions?: React.ReactNode;
}

// D1: read-only SQL viewer (Beluga is read-first: no Run action, no editable mode). The frame,
// toolbar and copy button are eager; the CodeMirror body is lazy and the statement is shown as a
// plain focusable <pre> until it is ready, so copy and reading never wait for the chunk.
export const SqlEditor: React.FC<SqlEditorProps> = ({
  value,
  theme,
  label,
  loadingLabel,
  loadFailedLabel,
  retryLabel,
  title,
  readOnlyBadgeLabel,
  copyLabel,
  copiedLabel,
  copyFailedLabel,
  className = '',
  extraActions,
}) => {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isMounted, setIsMounted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ownLoader = useRef<ReturnType<typeof newBodyLoader> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    setIsMounted(true);
    return () => clearTimeout(timer.current);
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(value);
    setCopyState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  };

  const statusText =
    copyState === 'copied' ? copiedLabel : copyState === 'failed' ? copyFailedLabel : '';
  const buttonText = copyState === 'copied' ? copiedLabel : copyLabel;

  const LoadedBody = (ownLoader.current ?? sharedBodyLoader).component();
  const staticFallback = <SqlStatic value={value} label={label} />;

  return (
    <div
      data-theme={theme}
      className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs ${className}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs">
        <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-mono font-bold">
          <Terminal className="h-4 w-4 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
          {title && <span>{title}</span>}
          {readOnlyBadgeLabel && (
            <span className="inline-flex items-center gap-1 rounded bg-slate-200/80 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-mono font-bold text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700">
              <Lock className="h-3 w-3 text-slate-500 dark:text-slate-400" aria-hidden="true" />
              {readOnlyBadgeLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white px-2 py-1 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors font-bold focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500"
          >
            {copyState === 'copied' ? (
              <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{buttonText}</span>
          </button>
          {/* Polite live region: the copy outcome (success or failure) is announced and, on failure, visible. */}
          <span role="status" className={copyState === 'failed' ? 'text-rose-700 dark:text-rose-300 font-bold' : 'sr-only'}>
            {statusText}
          </span>
          {extraActions}
        </div>
      </div>

      <div className="relative focus-within:ring-2 focus-within:ring-cyan-500 focus-within:ring-inset">
        {isMounted ? (
          <ChunkErrorBoundary
            key={attempt}
            value={value}
            label={label}
            failedLabel={loadFailedLabel}
            retryLabel={retryLabel}
            onRetry={() => {
              if (!ownLoader.current) ownLoader.current = newBodyLoader();
              else if (!ownLoader.current.retry()) return;
              setAttempt((n) => n + 1);
            }}
          >
          <Suspense
            fallback={
              <div aria-busy="true">
                <span role="status" className="sr-only">
                  {loadingLabel}
                </span>
                {staticFallback}
              </div>
            }
          >
            <LoadedBody value={value} theme={theme} label={label} />
          </Suspense>
          </ChunkErrorBoundary>
        ) : (
          staticFallback
        )}
      </div>
    </div>
  );
};

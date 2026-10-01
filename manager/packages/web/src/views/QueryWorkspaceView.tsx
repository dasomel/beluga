import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Terminal } from 'lucide-react';
import { Translations, Locale } from '../i18n/translations';
import { formatNumber } from '../i18n/format';
import { useDataAssets, useQueryContext } from '../api/hooks';
import { ErrorState, LoadingState } from '../components/QueryState';
import { getSafeExternalUrl } from './safeExternalUrl';

// Manager is not a query engine (#17): this view only shows the Trino addressing context and a
// read-only starter statement from GET /api/v1/data-assets/{id}/query-context. Execution and
// authorization stay in Trino, so there is intentionally no Run button or result grid.

interface QueryWorkspaceViewProps {
  t: Translations;
  locale?: Locale;
  initialAssetId?: string;
}

// Resolves false (never throws) when the Clipboard API is missing (insecure origin) or rejects.
export async function copyToClipboard(text: string, clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const QueryWorkspaceView: React.FC<QueryWorkspaceViewProps> = ({ t, locale = 'en-US', initialAssetId }) => {
  const assetsQuery = useDataAssets();
  const tableAssets = (assetsQuery.data?.data ?? []).filter((asset) => asset.kind === 'table');
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(initialAssetId ?? null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // A stale/unknown id (e.g. handed off for a non-table asset) falls back to the first table.
  const isKnown = (id: string | null) => id !== null && tableAssets.some((asset) => asset.id === id);
  const activeAssetId = isKnown(selectedAssetId) ? selectedAssetId : (tableAssets[0]?.id ?? null);
  const contextQuery = useQueryContext(activeAssetId);
  const context = contextQuery.data;
  const trinoUrl = getSafeExternalUrl(context?.trinoUiUrl);

  // Reset feedback on asset switch; the timer is cleared on change/unmount.
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [activeAssetId]);
  useEffect(() => {
    if (!copied && !copyFailed) return;
    const timer = setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);
    return () => clearTimeout(timer);
  }, [copied, copyFailed]);

  const copySql = async () => {
    if (!context) return;
    const ok = await copyToClipboard(context.sampleSql);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  let body: React.ReactNode;
  if (assetsQuery.isLoading) {
    body = <LoadingState t={t} />;
  } else if (assetsQuery.isError) {
    body = <ErrorState t={t} error={assetsQuery.error} />;
  } else if (tableAssets.length === 0) {
    body = (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-300 font-medium">
        {t.query.emptyState}
      </div>
    );
  } else if (!activeAssetId) {
    body = <p className="text-sm text-slate-500 dark:text-slate-300">{t.query.noTableSelected}</p>;
  } else if (contextQuery.isLoading) {
    body = <LoadingState t={t} />;
  } else if (contextQuery.isError) {
    body = <ErrorState t={t} error={contextQuery.error} />;
  } else if (context) {
    body = (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs">
          <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-mono font-bold">
            <Terminal className="h-4 w-4 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
            <span>{t.query.contextTitle}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copySql}
              className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white px-2 py-1 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors font-bold"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? t.common.copied : copyFailed ? t.query.copyFailed : t.query.copySql}
            </button>
            {trinoUrl && (
              <a
                href={trinoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 dark:bg-cyan-500 dark:hover:bg-cyan-400 text-white dark:text-slate-950 font-bold px-3.5 py-1.5 transition-colors shadow-xs"
              >
                {t.query.openInTrino}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 text-xs">
          <div>
            <dt className="text-slate-500 dark:text-slate-400 font-bold">{t.query.trinoTarget}</dt>
            <dd className="mt-1 font-mono font-bold text-slate-900 dark:text-white">
              {context.catalog}.{context.schema}.{context.table}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400 font-bold">{t.query.rowLimit}</dt>
            <dd className="mt-1 font-mono font-bold text-slate-900 dark:text-white">{formatNumber(context.rowLimit, locale)}</dd>
          </div>
        </dl>
        <div className="px-4 pb-4">
          <div className="mb-1.5 text-xs font-bold text-slate-600 dark:text-slate-300">{t.query.starterSql}</div>
          <pre className="rounded-lg bg-slate-950 p-4 border border-slate-800 text-xs font-mono text-cyan-300 overflow-x-auto leading-relaxed">
            {context.sampleSql}
          </pre>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-medium">{t.query.readOnlyNote}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.query.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.query.subtitle}</p>
      </div>

      {tableAssets.length > 0 && (
        <label className="flex flex-col gap-1.5 text-xs font-bold text-slate-600 dark:text-slate-300 max-w-md">
          {t.query.assetLabel}
          <select
            value={activeAssetId ?? ''}
            onChange={(e) => setSelectedAssetId(e.target.value)}
            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono text-slate-900 dark:text-white"
          >
            {tableAssets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {body}
    </div>
  );
};

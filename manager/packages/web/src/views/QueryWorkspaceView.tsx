import React, { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { ExternalLink, History, Info, Terminal } from 'lucide-react';
import { Translations, Locale } from '../i18n/translations';
import { formatNumber } from '../i18n/format';
import { useDataAssets, useQueryContext, useQueryHistory } from '../api/hooks';
import type { QueryHistoryEntry } from '@beluga-manager/domain-api/schema';
import { ErrorState, LoadingState } from '../components/QueryState';
import { SqlEditor } from '../components/SqlEditor';
import type { EditorTheme } from '../components/sqlEditorTheme';
export { copyToClipboard } from '../components/clipboard';
import { DataTable } from '../components/DataTable';
import { getSafeExternalUrl } from './safeExternalUrl';

// Manager is not a query engine (#17): this view only shows the Trino addressing context and a
// read-only starter statement from GET /api/v1/data-assets/{id}/query-context, plus an upstream
// query history snapshot from GET /api/v1/query-history. Execution and authorization stay in Trino,
// so there is intentionally no Run button or interactive execution grid.

interface QueryWorkspaceViewProps {
  t: Translations;
  locale?: Locale;
  theme: EditorTheme;
  initialAssetId?: string;
}

export const QueryWorkspaceView: React.FC<QueryWorkspaceViewProps> = ({
  t,
  locale = 'en-US',
  theme,
  initialAssetId,
}) => {
  const assetsQuery = useDataAssets();
  const tableAssets = (assetsQuery.data?.data ?? []).filter((asset) => asset.kind === 'table');
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(initialAssetId ?? null);

  // A stale/unknown id (e.g. handed off for a non-table asset) falls back to the first table.
  const isKnown = (id: string | null) => id !== null && tableAssets.some((asset) => asset.id === id);
  const activeAssetId = isKnown(selectedAssetId) ? selectedAssetId : (tableAssets[0]?.id ?? null);
  const contextQuery = useQueryContext(activeAssetId);
  const context = contextQuery.data;
  const trinoUrl = getSafeExternalUrl(context?.trinoUiUrl);

  const [historyPage, setHistoryPage] = useState(1);
  const historyQuery = useQueryHistory(historyPage, 20);

  const isHistory503 =
    historyQuery.isError &&
    ((historyQuery.error as { status?: number })?.status === 503 ||
      String(historyQuery.error).includes('503'));

  const historyColumns = useMemo<ColumnDef<QueryHistoryEntry, any>[]>(
    () => [
      {
        accessorKey: 'id',
        header: t.query.historyColumns.id,
        cell: (info) => (
          <span className="font-mono text-xs font-bold text-slate-900 dark:text-white">
            {String(info.getValue())}
          </span>
        ),
      },
      {
        accessorKey: 'sql',
        header: t.query.historyColumns.sql,
        cell: (info) => (
          // No title attribute: it would copy the (unmasked) SQL into tooltips and assistive tech.
          <span className="font-mono text-xs text-cyan-800 dark:text-cyan-300 truncate max-w-md block">
            {String(info.getValue())}
          </span>
        ),
      },
      {
        accessorKey: 'state',
        header: t.query.historyColumns.state,
        cell: (info) => {
          const state = String(info.getValue());
          const isFinished = state === 'FINISHED';
          const isFailed = state === 'FAILED';
          const badgeClass = isFinished
            ? 'bg-emerald-50 dark:bg-emerald-950/80 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-700'
            : isFailed
              ? 'bg-rose-50 dark:bg-rose-950/80 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-700'
              : 'bg-cyan-50 dark:bg-cyan-950/80 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-700';
          return (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${badgeClass}`}
            >
              {state}
            </span>
          );
        },
      },
    ],
    [t],
  );

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
            <dd className="mt-1 font-mono font-bold text-slate-900 dark:text-white">
              {formatNumber(context.rowLimit, locale)}
            </dd>
          </div>
        </dl>

        <div className="px-4 pb-4">
          <SqlEditor
            value={context.sampleSql}
            title={t.query.starterSql}
            theme={theme}
            label={t.query.editorAriaLabel}
            loadingLabel={t.common.editorLoading}
            loadFailedLabel={t.common.editorLoadFailed}
            retryLabel={t.common.retry}
            readOnlyBadgeLabel={t.query.readOnlyBadge}
            copyLabel={t.query.copySql}
            copiedLabel={t.common.copied}
            copyFailedLabel={t.query.copyFailed}
          />
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t.query.readOnlyNote}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
          {t.query.title}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">
          {t.query.subtitle}
        </p>
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

      {/* Query History Section */}
      <div className="space-y-3 pt-6 border-t border-slate-200 dark:border-slate-800">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
            <History className="h-5 w-5 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
            <span>{t.query.historyTitle}</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 font-medium">
            {t.query.historySubtitle}
          </p>
        </div>

        {isHistory503 ? (
          <div className="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 p-6 text-xs text-amber-800 dark:text-amber-300 font-medium flex items-start gap-3">
            <Info className="h-5 w-5 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div>
              <p className="font-bold">{t.query.historyUnavailable}</p>
            </div>
          </div>
        ) : (
          <>
          <p role="note" className="rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 font-medium flex items-start gap-2">
            <Info className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>{t.query.historyPrivacyNotice}</span>
          </p>
          <DataTable
            data={historyQuery.data?.data ?? []}
            columns={historyColumns}
            t={t}
            locale={locale}
            isLoading={historyQuery.isLoading}
            error={!isHistory503 ? historyQuery.error : null}
            emptyMessage={t.query.historyEmpty}
            ariaLabel={t.query.historyTitle}
            pagination={
              historyQuery.data?.meta
                ? {
                    page: historyQuery.data.meta.page,
                    pageSize: historyQuery.data.meta.pageSize,
                    total: historyQuery.data.meta.total,
                    onPageChange: (newPage) => setHistoryPage(newPage),
                  }
                : undefined
            }
          />
          </>
        )}
      </div>
    </div>
  );
};

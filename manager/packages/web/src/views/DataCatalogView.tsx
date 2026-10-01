import React, { useState } from 'react';
import { Database, Table, Key, Copy, Check, HardDrive, Sparkles } from 'lucide-react';
import type { DataAssetDetail } from '@beluga-manager/domain-api/schema';
import { useDataAssets, useDataAsset } from '../api/hooks';
import { LoadingState, ErrorState } from '../components/QueryState';
import { StatusBadge } from '../components/StatusBadge';
import { formatDateTime } from '../i18n/format';
import { interpolateCount } from '../i18n/interpolate';
import { Locale, Translations } from '../i18n/translations';
import type { CatalogTable } from '../data/mockData';
import { buildCatalogSampleSql } from './catalogSql';

export function toCatalogTable(asset: DataAssetDetail): CatalogTable {
  const parts = asset.name.split('.');
  const schema = parts.length > 1 ? parts[0]! : 'default';
  const table = parts.length > 1 ? parts.slice(1).join('.') : parts[0]!;
  const partitionSpec = asset.metadataSummary?.partitionSpec ?? '';
  return {
    catalog: 'beluga_lake',
    schema,
    table,
    format: asset.format ?? 'Iceberg v2 (Parquet)',
    location: asset.location ?? '',
    snapshotCount: asset.metadataSummary?.snapshotCount ?? 0,
    columns: (asset.columns ?? []).map((col) => ({
      name: col.name,
      type: col.type,
      comment: col.comment,
      isPartition: partitionSpec.includes(col.name),
    })),
  };
}

// This is the exact handoff logic (asset id only; Query Workspace fetches its own context) the "Open in Query" button's onClick calls (see
// the button below). It is exported so the catalog -> query handoff can be verified by calling
// this function directly against a real onSelectQuery callback, instead of a test re-deriving the
// same values independently.
export function handleOpenInQuerySelection(
  asset: DataAssetDetail,
  onSelectQuery: (assetId: string) => void,
): void {
  onSelectQuery(asset.id);
}

interface DataCatalogViewProps {
  t: Translations;
  locale?: Locale;
  onSelectQuery?: (assetId: string) => void;
  initialAssetId?: string;
}

export const DataCatalogView: React.FC<DataCatalogViewProps> = ({
  t,
  locale = 'en-US',
  onSelectQuery,
  initialAssetId,
}) => {
  const dataAssetsQuery = useDataAssets();
  const tableAssets = (dataAssetsQuery.data?.data ?? []).filter((asset) => asset.kind === 'table');

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(initialAssetId ?? null);
  const [copied, setCopied] = useState(false);

  const activeAssetId = selectedAssetId ?? tableAssets[0]?.id ?? null;
  const assetDetailQuery = useDataAsset(activeAssetId);
  const selectedTable = assetDetailQuery.data ?? null;

  const catalogTable = selectedTable ? toCatalogTable(selectedTable) : null;
  const sampleSql = catalogTable ? buildCatalogSampleSql(catalogTable) : '';

  const copySql = () => {
    if (!sampleSql) return;
    navigator.clipboard.writeText(sampleSql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.catalog.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.catalog.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left: Table Navigator Tree */}
        <div className="lg:col-span-1 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 shadow-xs backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-200 dark:border-slate-800">
            <Database className="h-4 w-4 text-cyan-700 dark:text-cyan-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
              {t.catalog.lakekeeperCatalog}
            </span>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-mono text-slate-700 dark:text-slate-300 px-2 py-1 font-bold flex items-center gap-1.5">
              <span>beluga_lake</span>
              <span className="text-[10px] text-slate-400 font-normal">/ default</span>
            </div>

            {dataAssetsQuery.isLoading && <LoadingState t={t} />}
            {!dataAssetsQuery.isLoading && dataAssetsQuery.isError && (
              <ErrorState t={t} error={dataAssetsQuery.error} />
            )}
            {!dataAssetsQuery.isLoading && !dataAssetsQuery.isError && (
              <div className="space-y-1 pl-2">
                {tableAssets.map((asset) => {
                  const isSelected = activeAssetId === asset.id;
                  return (
                    <button
                      key={asset.id}
                      onClick={() => setSelectedAssetId(asset.id)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs font-bold transition-colors flex items-center justify-between ${
                        isSelected
                          ? 'bg-cyan-50 dark:bg-cyan-950/80 text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/60 shadow-xs'
                          : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center gap-2 truncate">
                        <Table className="h-3.5 w-3.5 flex-shrink-0" />
                        <span className="font-mono truncate">{asset.name}</span>
                      </div>
                      <StatusBadge status={asset.status} t={t} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right: Table Detail & Schema */}
        <div className="lg:col-span-3 space-y-6">
          {assetDetailQuery.isLoading && <LoadingState t={t} />}
          {!assetDetailQuery.isLoading && assetDetailQuery.isError && (
            <ErrorState t={t} error={assetDetailQuery.error} />
          )}
          {!assetDetailQuery.isLoading && !assetDetailQuery.isError && !selectedTable && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500 dark:text-slate-400 font-medium">
              {t.catalog.emptyState}
            </div>
          )}
          {!assetDetailQuery.isLoading && !assetDetailQuery.isError && selectedTable && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white font-mono">
                      {selectedTable.name}
                    </h2>
                    {selectedTable.format && (
                      <span className="rounded-full bg-blue-50 dark:bg-blue-950/80 px-2.5 py-0.5 text-xs font-bold text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-700 font-mono">
                        {selectedTable.format}
                      </span>
                    )}
                    <StatusBadge status={selectedTable.status} t={t} />
                  </div>
                  {selectedTable.location && (
                    <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 dark:text-slate-300 font-mono font-medium">
                      <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                      <span>{selectedTable.location}</span>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-2.5 border border-slate-200 dark:border-slate-800 text-center shadow-xs">
                    <div className="text-[10px] text-slate-400 uppercase font-mono font-bold">{t.catalog.snapshots}</div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white font-mono">
                      {selectedTable.metadataSummary?.snapshotCount ?? '-'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-2.5 border border-slate-200 dark:border-slate-800 text-center shadow-xs">
                    <div className="text-[10px] text-slate-400 uppercase font-mono font-bold">{t.catalog.partitionSpec}</div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white font-mono">
                      {selectedTable.metadataSummary?.partitionSpec ?? '-'}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-2.5 border border-slate-200 dark:border-slate-800 text-center shadow-xs">
                    <div className="text-[10px] text-slate-400 uppercase font-mono font-bold">{t.catalog.lastUpdated}</div>
                    <div className="text-sm font-bold text-slate-900 dark:text-white font-mono">
                      {selectedTable.metadataSummary?.lastUpdated
                        ? formatDateTime(selectedTable.metadataSummary.lastUpdated, locale)
                        : '-'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Columns Schema Table */}
              <div className="mt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                    {t.catalog.columns}
                  </h3>
                  <span className="text-xs text-slate-500 dark:text-slate-400 font-mono font-medium">
                    {interpolateCount(t.catalog.columnsCount, selectedTable.columns?.length ?? 0, locale)}
                  </span>
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-950">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-mono font-bold">
                      <tr>
                        <th className="py-2.5 px-3">{t.catalog.columnName}</th>
                        <th className="py-2.5 px-3">{t.catalog.dataType}</th>
                        <th className="py-2.5 px-3">{t.catalog.nullable}</th>
                        <th className="py-2.5 px-3">{t.catalog.partition}</th>
                        <th className="py-2.5 px-3">{t.catalog.description}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80 font-mono">
                      {(selectedTable.columns ?? []).map((col) => {
                        const isPartition =
                          selectedTable.metadataSummary?.partitionSpec?.includes(col.name) ?? false;
                        return (
                          <tr key={col.name} className="hover:bg-slate-50 dark:hover:bg-slate-850/60">
                            <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-white">{col.name}</td>
                            <td className="py-2.5 px-3 text-cyan-700 dark:text-cyan-400 font-bold">{col.type}</td>
                            <td className="py-2.5 px-3 text-slate-600 dark:text-slate-400">
                              {col.nullable ? t.catalog.nullable : t.catalog.notNullable}
                            </td>
                            <td className="py-2.5 px-3">
                              {isPartition ? (
                                <span className="inline-flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-700 font-bold">
                                  <Key className="h-2.5 w-2.5" /> {t.catalog.partition}
                                </span>
                              ) : (
                                <span className="text-slate-400">-</span>
                              )}
                            </td>
                            <td className="py-2.5 px-3 font-sans text-slate-600 dark:text-slate-300 font-medium">
                              {col.comment || '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Sample Query Box */}
              {sampleSql && (
                <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                      <Sparkles className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-400" /> {t.catalog.queryTemplate}
                    </span>
                    <div className="flex items-center gap-4">
                      {onSelectQuery && selectedTable && (
                        <button
                          onClick={() => handleOpenInQuerySelection(selectedTable, onSelectQuery)}
                          className="text-xs text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100 font-mono font-bold transition-colors"
                        >
                          {t.catalog.openInQuery}
                        </button>
                      )}
                      <button
                        onClick={copySql}
                        className="flex items-center gap-1 text-xs text-slate-600 hover:text-cyan-800 dark:text-slate-300 dark:hover:text-cyan-300 font-mono font-bold transition-colors"
                      >
                        {copied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                        {copied ? t.common.copied : t.catalog.copySql}
                      </button>
                    </div>
                  </div>
                  <pre className="rounded-lg bg-slate-950 p-4 border border-slate-800 text-xs font-mono text-cyan-300 overflow-x-auto shadow-inner leading-relaxed selection:bg-cyan-600 selection:text-white">
                    {sampleSql}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

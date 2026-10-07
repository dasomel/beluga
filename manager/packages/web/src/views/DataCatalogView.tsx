import React, { useMemo, useState } from 'react';
import { Database, Table, Key, Copy, Check, HardDrive, Sparkles, ChevronRight, ChevronDown, Folder } from 'lucide-react';
import { ColumnDef } from '@tanstack/react-table';
import type { DataAsset, DataAssetDetail } from '@beluga-manager/domain-api/schema';
import { useDataAssets, useDataAsset, useDataAssetChildren } from '../api/hooks';
import { LoadingState, ErrorState } from '../components/QueryState';
import { StatusBadge } from '../components/StatusBadge';
import { DataTable } from '../components/DataTable';
import { SqlEditor } from '../components/SqlEditor';
import type { EditorTheme } from '../components/sqlEditorTheme';
import { formatDateTime } from '../i18n/format';
import { interpolateCount } from '../i18n/interpolate';
import { Locale, Translations } from '../i18n/translations';
import type { CatalogTable } from '../data/mockData';
import { buildCatalogSampleSql } from './catalogSql';
import { isExpandableKind, toggleExpanded } from './catalogTree';

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

interface AssetRowProps {
  asset: DataAsset;
  t: Translations;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

// Selectable leaf row (table); shared by tree leaves, orphan tables and the legacy flat list.
const AssetRow: React.FC<AssetRowProps> = ({ asset, t, isSelected, onSelect }) => (
  <button
    onClick={() => onSelect(asset.id)}
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

interface CatalogTreeNodeProps {
  asset: DataAsset;
  t: Translations;
  activeAssetId: string | null;
  onSelect: (id: string) => void;
  defaultExpanded?: ReadonlySet<string>;
}

// One node of the lazy catalog tree: children are fetched via `?parentId=` only after expand.
export const CatalogTreeNode: React.FC<CatalogTreeNodeProps> = ({
  asset,
  t,
  activeAssetId,
  onSelect,
  defaultExpanded,
}) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(defaultExpanded ?? new Set());
  const expandable = isExpandableKind(asset.kind);
  const isOpen = expandable && expanded.has(asset.id);
  const childrenQuery = useDataAssetChildren(asset.id, isOpen);
  const children = childrenQuery.data?.data ?? [];
  const Icon = asset.kind === 'catalog' ? Database : asset.kind === 'schema' ? Folder : Table;

  if (!expandable) {
    return <AssetRow asset={asset} t={t} isSelected={activeAssetId === asset.id} onSelect={onSelect} />;
  }

  return (
    <div>
      <button
        onClick={() => setExpanded((prev) => toggleExpanded(prev, asset.id))}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? t.catalog.treeCollapse : t.catalog.treeExpand} ${asset.name}`}
        className="w-full text-left px-2 py-1 rounded-lg text-xs font-bold font-mono text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 flex items-center gap-1.5"
      >
        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Icon className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate">{asset.name}</span>
      </button>
      {isOpen && (
        <div className="space-y-1 pl-3 mt-1">
          {childrenQuery.isLoading && <LoadingState t={t} />}
          {!childrenQuery.isLoading && childrenQuery.isError && <ErrorState t={t} error={childrenQuery.error} />}
          {!childrenQuery.isLoading && !childrenQuery.isError && children.length === 0 && (
            <div className="px-2 py-1 text-xs text-slate-500 dark:text-slate-400 font-medium">{t.catalog.treeEmpty}</div>
          )}
          {!childrenQuery.isLoading &&
            !childrenQuery.isError &&
            children.map((child) => (
              <CatalogTreeNode
                key={child.id}
                asset={child}
                t={t}
                activeAssetId={activeAssetId}
                onSelect={onSelect}
                defaultExpanded={defaultExpanded}
              />
            ))}
        </div>
      )}
    </div>
  );
};

interface DataCatalogViewProps {
  t: Translations;
  locale?: Locale;
  theme: EditorTheme;
  onSelectQuery?: (assetId: string) => void;
  initialAssetId?: string;
}

export const DataCatalogView: React.FC<DataCatalogViewProps> = ({
  t,
  locale = 'en-US',
  theme,
  onSelectQuery,
  initialAssetId,
}) => {
  // Catalog roots are requested with kind=catalog so the pageSize cap on the mixed list can never
  // hide one. The unfiltered list is kept for the legacy flat table list and for orphan tables
  // (kind=table without a catalog parent) rendered next to the catalogs. When there are no
  // catalogs, the legacy flat list is used so older/flat deployments still navigate.
  const rootsQuery = useDataAssets('catalog');
  const allAssetsQuery = useDataAssets();
  const catalogAssets = rootsQuery.data?.data ?? [];
  const tableAssets = (allAssetsQuery.data?.data ?? []).filter((asset) => asset.kind === 'table');
  const orphanTables = tableAssets.filter((asset) => !asset.parentId);
  const dataAssetsQuery = rootsQuery.isError ? rootsQuery : allAssetsQuery;
  const listLoading = rootsQuery.isLoading || allAssetsQuery.isLoading;
  const listError = rootsQuery.isError || allAssetsQuery.isError;
  const treeMode = catalogAssets.length > 0;

  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(initialAssetId ?? null);

  // In tree mode a table is only auto-selected when it is visible (orphan); otherwise the detail
  // pane would show a table that is not highlighted in the collapsed tree.
  const defaultAssetId = rootsQuery.isLoading
    ? null
    : (treeMode ? orphanTables : tableAssets)[0]?.id ?? null;
  const activeAssetId = selectedAssetId ?? defaultAssetId;
  const assetDetailQuery = useDataAsset(activeAssetId);
  const selectedTable = assetDetailQuery.data ?? null;

  const catalogTable = selectedTable ? toCatalogTable(selectedTable) : null;
  const sampleSql = catalogTable ? buildCatalogSampleSql(catalogTable) : '';

  type TableColumn = NonNullable<DataAssetDetail['columns']>[number];
  const schemaColumns = useMemo<ColumnDef<TableColumn, any>[]>(
    () => [
      {
        accessorKey: 'name',
        header: t.catalog.columnName,
        cell: (info) => (
          <span className="font-bold text-slate-900 dark:text-white font-mono">
            {String(info.getValue())}
          </span>
        ),
      },
      {
        accessorKey: 'type',
        header: t.catalog.dataType,
        cell: (info) => (
          <span className="text-cyan-700 dark:text-cyan-400 font-bold font-mono">
            {String(info.getValue())}
          </span>
        ),
      },
      {
        accessorKey: 'nullable',
        header: t.catalog.nullable,
        cell: (info) => (
          <span className="text-slate-600 dark:text-slate-400 font-mono">
            {info.getValue() ? t.catalog.nullable : t.catalog.notNullable}
          </span>
        ),
      },
      {
        id: 'partition',
        header: t.catalog.partition,
        cell: ({ row }) => {
          const col = row.original;
          const isPartition =
            selectedTable?.metadataSummary?.partitionSpec?.includes(col.name) ?? false;
          return isPartition ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/80 px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-700 font-bold font-mono">
              <Key className="h-2.5 w-2.5" /> {t.catalog.partition}
            </span>
          ) : (
            <span className="text-slate-400 font-mono">-</span>
          );
        },
      },
      {
        accessorKey: 'comment',
        header: t.catalog.description,
        cell: (info) => (
          <span className="font-sans text-slate-600 dark:text-slate-300 font-medium">
            {String(info.getValue() || '-')}
          </span>
        ),
      },
    ],
    [t, selectedTable],
  );

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
            {!treeMode && (
              <div className="text-xs font-mono text-slate-700 dark:text-slate-300 px-2 py-1 font-bold flex items-center gap-1.5">
                <span>beluga_lake</span>
                <span className="text-[10px] text-slate-400 font-normal">/ default</span>
              </div>
            )}

            {listLoading && <LoadingState t={t} />}
            {!listLoading && listError && <ErrorState t={t} error={dataAssetsQuery.error} />}
            {!listLoading && !listError && treeMode && (
              <div className="space-y-1">
                {catalogAssets.map((catalog) => (
                  <CatalogTreeNode
                    key={catalog.id}
                    asset={catalog}
                    t={t}
                    activeAssetId={activeAssetId}
                    onSelect={setSelectedAssetId}
                  />
                ))}
                {orphanTables.map((asset) => (
                  <AssetRow
                    key={asset.id}
                    asset={asset}
                    t={t}
                    isSelected={activeAssetId === asset.id}
                    onSelect={setSelectedAssetId}
                  />
                ))}
              </div>
            )}
            {!listLoading && !listError && !treeMode && (
              <div className="space-y-1 pl-2">
                {tableAssets.map((asset) => (
                  <AssetRow
                    key={asset.id}
                    asset={asset}
                    t={t}
                    isSelected={activeAssetId === asset.id}
                    onSelect={setSelectedAssetId}
                  />
                ))}
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
                <DataTable
                  data={selectedTable.columns ?? []}
                  columns={schemaColumns}
                  t={t}
                  locale={locale}
                  ariaLabel={t.catalog.columns}
                  emptyMessage={t.table.emptyRows}
                />
              </div>

              {/* Sample Query Box */}
              {sampleSql && (
                <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
                  <SqlEditor
                    value={sampleSql}
                    theme={theme}
                    label={t.catalog.editorAriaLabel}
                    loadingLabel={t.common.editorLoading}
                    loadFailedLabel={t.common.editorLoadFailed}
                    retryLabel={t.common.retry}
                    title={t.catalog.queryTemplate}
                    copyLabel={t.catalog.copySql}
                    copiedLabel={t.common.copied}
                    copyFailedLabel={t.catalog.copyFailed}
                    extraActions={
                      onSelectQuery && selectedTable ? (
                        <button
                          type="button"
                          onClick={() => handleOpenInQuerySelection(selectedTable, onSelectQuery)}
                          className="text-xs text-cyan-700 hover:text-cyan-900 dark:text-cyan-300 dark:hover:text-cyan-100 font-mono font-bold transition-colors"
                        >
                          {t.catalog.openInQuery}
                        </button>
                      ) : null
                    }
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  SortingFn,
  SortingState,
  useReactTable,
  VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Columns3 } from 'lucide-react';
import { Translations, Locale } from '../i18n/translations';
import { interpolate } from '../i18n/interpolate';
import { LoadingState, ErrorState } from './QueryState';
import { createCollator, disclosureAction, tanstackSortResult } from './dataTableSort';

export interface DataTablePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange?: (page: number) => void;
}

export interface DataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, any>[];
  t: Translations;
  locale?: Locale;
  isLoading?: boolean;
  error?: unknown;
  emptyMessage?: string;
  /** Accessible name of the scrollable table region -- required. */
  ariaLabel: string;
  initialSorting?: SortingState;
  className?: string;
  maxHeight?: string;
  stickyHeader?: boolean;
  enableColumnVisibility?: boolean;
  pagination?: DataTablePaginationProps;
  extraToolbar?: React.ReactNode;
}

// D1: TanStack Table (MIT, ADR-0003) headless grid component: sorting (aria-sort on the th, a
// button per column whose name includes the column), column visibility (disclosure + checkboxes),
// sticky header, row count. No virtualization: schema columns (<50) and paginated history (<50)
// do not justify it. D2: column visibility is NOT persisted (resets on remount); there is no
// stable per-table key yet, so persisting is deferred rather than guessed.
// Sorting: numbers numerically, strings by Intl.Collator(locale, numeric), empties (null/undefined/NaN)
// always last in both directions, stable (see dataTableSort.ts).
export function DataTable<TData>({
  data,
  columns,
  t,
  locale = 'en-US',
  isLoading = false,
  error = null,
  emptyMessage,
  ariaLabel,
  initialSorting = [],
  className = '',
  maxHeight = '500px',
  stickyHeader = true,
  enableColumnVisibility = true,
  pagination,
  extraToolbar,
}: DataTableProps<TData>): React.ReactElement {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [isVisibilityMenuOpen, setIsVisibilityMenuOpen] = useState(false);
  const panelId = useId();
  const disclosureRef = useRef<HTMLDivElement>(null);
  const disclosureButtonRef = useRef<HTMLButtonElement>(null);

  // Esc closes and returns focus to the button; a pointer press or focus moving outside closes.
  useEffect(() => {
    if (!isVisibilityMenuOpen) return;
    const inside = (n: EventTarget | null) => n instanceof Node && !!disclosureRef.current?.contains(n);
    const onKey = (e: KeyboardEvent) => {
      if (disclosureAction({ type: 'key', key: e.key }) === 'close-and-refocus') {
        setIsVisibilityMenuOpen(false);
        disclosureButtonRef.current?.focus();
      }
    };
    const onPointer = (e: PointerEvent) => {
      if (disclosureAction({ type: 'pointer', insidePanelOrButton: inside(e.target) }) === 'close') {
        setIsVisibilityMenuOpen(false);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      if (e.relatedTarget && disclosureAction({ type: 'focusout', nextFocusInside: inside(e.relatedTarget) }) === 'close') {
        setIsVisibilityMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    const root = disclosureRef.current;
    root?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
      root?.removeEventListener('focusout', onFocusOut);
    };
  }, [isVisibilityMenuOpen]);

  const collator = useMemo(() => createCollator(locale), [locale]);
  const sortingFn = useMemo<SortingFn<TData>>(
    () => (rowA, rowB, columnId) =>
      tanstackSortResult(
        rowA.getValue(columnId),
        rowB.getValue(columnId),
        sorting.find((s) => s.id === columnId)?.desc ?? false,
        collator,
      ),
    [sorting, collator],
  );

  const table = useReactTable({
    data,
    columns,
    defaultColumn: { sortingFn },
    state: {
      sorting,
      columnVisibility,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rowCountText = interpolate(t.table.rowsCount, { count: table.getRowModel().rows.length }, locale);
  const totalPages = pagination ? Math.max(1, Math.ceil(pagination.total / pagination.pageSize)) : 1;
  const pageText = pagination
    ? interpolate(t.table.page, { page: pagination.page, total: totalPages }, locale)
    : '';

  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  return (
    <div
      className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs ${className}`}
    >
      {/* Table Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-slate-700 dark:text-slate-300">{rowCountText}</span>
          {extraToolbar}
        </div>

        <div className="flex items-center gap-2">
          {enableColumnVisibility && hideableColumns.length > 0 && (
            <div className="relative" ref={disclosureRef}>
              <button
                type="button"
                ref={disclosureButtonRef}
                onClick={() => setIsVisibilityMenuOpen(!isVisibilityMenuOpen)}
                aria-expanded={isVisibilityMenuOpen}
                aria-controls={panelId}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-bold hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500"
              >
                <Columns3 className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
                <span>{t.table.columnsVisibility}</span>
              </button>

              {isVisibilityMenuOpen && (
                <div
                  id={panelId}
                  role="group"
                  aria-label={t.table.columnsVisibility}
                  className="absolute right-0 mt-1 z-20 w-56 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg p-2 text-xs"
                >
                  <div className="flex items-center justify-between pb-1.5 mb-1.5 border-b border-slate-100 dark:border-slate-800">
                    <button
                      type="button"
                      onClick={() => table.toggleAllColumnsVisible(true)}
                      className="text-[11px] font-bold text-cyan-700 dark:text-cyan-400 hover:underline"
                    >
                      {t.table.showAllColumns}
                    </button>
                    <button
                      type="button"
                      onClick={() => table.resetColumnVisibility()}
                      className="text-[11px] text-slate-500 dark:text-slate-400 hover:underline"
                    >
                      {t.table.resetColumns}
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {hideableColumns.map((column) => {
                      const colHeader = column.columnDef.header;
                      const label = typeof colHeader === 'string' ? colHeader : column.id;
                      const toggleAria = interpolate(t.table.toggleColumn, { column: label }, locale);
                      return (
                        <label
                          key={column.id}
                          className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer text-slate-700 dark:text-slate-300"
                        >
                          <input
                            type="checkbox"
                            checked={column.getIsVisible()}
                            onChange={column.getToggleVisibilityHandler()}
                            aria-label={toggleAria}
                            className="rounded border-slate-300 dark:border-slate-700 text-cyan-600 focus:ring-cyan-500"
                          />
                          <span className="truncate">{label}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Main Table Content */}
      {isLoading ? (
        <div className="p-4">
          <LoadingState t={t} />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorState t={t} error={error} />
        </div>
      ) : (
        <div
          tabIndex={0}
          role="region"
          aria-label={ariaLabel}
          style={{ maxHeight }}
          className="overflow-auto focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500"
        >
          <table role="table" className="w-full text-left text-xs border-collapse">
            <thead
              className={`border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-mono font-bold ${
                stickyHeader ? 'sticky top-0 z-10 shadow-xs' : ''
              }`}
            >
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const canSort = header.column.getCanSort();
                    const isSorted = header.column.getIsSorted();
                    const sortAria =
                      isSorted === 'asc'
                        ? 'ascending'
                        : isSorted === 'desc'
                          ? 'descending'
                          : 'none';
                    const headerDef = header.column.columnDef.header;
                    const columnLabel = typeof headerDef === 'string' ? headerDef : header.column.id;
                    const sortActionLabel = interpolate(
                      t.table.sortBy,
                      {
                        column: columnLabel,
                        state:
                          isSorted === 'asc'
                            ? t.table.sortStateAscending
                            : isSorted === 'desc'
                              ? t.table.sortStateDescending
                              : t.table.sortStateNone,
                      },
                      locale,
                    );

                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={canSort ? sortAria : undefined}
                        className="py-2.5 px-3 whitespace-nowrap"
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-label={sortActionLabel}
                            className="inline-flex items-center gap-1.5 hover:text-slate-900 dark:hover:text-white transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500 rounded px-1 py-0.5"
                          >
                            <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                            {isSorted === 'asc' ? (
                              <ArrowUp className="h-3 w-3 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                            ) : isSorted === 'desc' ? (
                              <ArrowDown className="h-3 w-3 text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                            ) : (
                              <ArrowUpDown className="h-3 w-3 opacity-40 hover:opacity-100" aria-hidden="true" />
                            )}
                          </button>
                        ) : (
                          <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>

            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80 font-mono">
              {table.getRowModel().rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={table.getVisibleLeafColumns().length || 1}
                    className="py-8 px-4 text-center text-slate-500 dark:text-slate-400 font-medium font-sans"
                  >
                    {emptyMessage || t.table.emptyRows}
                  </td>
                </tr>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className="hover:bg-slate-50/70 dark:hover:bg-slate-800/60 transition-colors"
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="py-2.5 px-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Controls */}
      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 text-xs">
          <span className="font-mono text-slate-500 dark:text-slate-400">{pageText}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange?.(pagination.page - 1)}
              aria-label={t.table.previousPage}
              className="p-1 rounded text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 disabled:pointer-events-none hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange?.(pagination.page + 1)}
              aria-label={t.table.nextPage}
              className="p-1 rounded text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white disabled:opacity-30 disabled:pointer-events-none hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-500"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

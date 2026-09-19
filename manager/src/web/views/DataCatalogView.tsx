import React, { useState } from 'react';
import { Database, Table, Key, Copy, Check, HardDrive, Sparkles } from 'lucide-react';
import { Translations } from '../i18n/translations';
import { catalogTablesData, CatalogTable } from '../data/mockData';

interface DataCatalogViewProps {
  t: Translations;
  onSelectQuery?: (sql: string) => void;
}

export const DataCatalogView: React.FC<DataCatalogViewProps> = ({ t }) => {
  const [selectedTable, setSelectedTable] = useState<CatalogTable>(catalogTablesData[0]!);
  const [copied, setCopied] = useState(false);

  const sampleSql = `SELECT \n  order_id, \n  customer_id, \n  order_status, \n  total_amount, \n  order_date\nFROM ${selectedTable.catalog}.${selectedTable.schema}.${selectedTable.table}\nORDER BY created_at DESC\nLIMIT 20;`;

  const copySql = () => {
    navigator.clipboard.writeText(sampleSql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.catalog.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.catalog.subtitle}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left: Table Navigator Tree */}
        <div className="lg:col-span-1 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-4 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-3 pb-2 border-b border-slate-200 dark:border-slate-800">
            <Database className="h-4 w-4 text-cyan-700 dark:text-cyan-400" />
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">Lakekeeper Catalog</span>
          </div>

          <div className="space-y-1">
            <div className="text-xs font-mono text-slate-600 dark:text-slate-400 px-2 py-1 font-bold flex items-center gap-1.5">
              <span>beluga_lake</span>
              <span className="text-[10px] text-slate-400 font-normal">/ default</span>
            </div>

            <div className="space-y-1 pl-2">
              {catalogTablesData.map((table) => {
                const isSelected = selectedTable.table === table.table;
                return (
                  <button
                    key={table.table}
                    onClick={() => setSelectedTable(table)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-xs font-semibold transition-colors flex items-center justify-between ${
                      isSelected
                        ? 'bg-cyan-50 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-500/40 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-100/70 dark:hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Table className="h-3.5 w-3.5 flex-shrink-0" />
                      <span className="font-mono">{table.table}</span>
                    </div>
                    <span className="text-[10px] rounded bg-slate-100 dark:bg-slate-800 px-1 font-mono text-slate-600 dark:text-slate-400 font-medium border border-slate-200 dark:border-transparent">
                      {table.columns.length} cols
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right: Table Detail & Schema */}
        <div className="lg:col-span-3 space-y-6">
          {/* Metadata Card */}
          <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-none backdrop-blur-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white font-mono">{selectedTable.catalog}.{selectedTable.schema}.{selectedTable.table}</h2>
                  <span className="rounded-full bg-blue-50 dark:bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20 font-mono">
                    {selectedTable.format}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
                  <HardDrive className="h-3.5 w-3.5 text-slate-400" />
                  <span>{selectedTable.location}</span>
                </div>
              </div>

              <div className="flex items-center gap-4 text-xs">
                <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-2.5 border border-slate-200 dark:border-slate-800 text-center shadow-xs">
                  <div className="text-[10px] text-slate-400 uppercase font-mono font-semibold">Snapshots</div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white font-mono">{selectedTable.snapshotCount}</div>
                </div>
              </div>
            </div>

            {/* Columns Schema Table */}
            <div className="mt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-3">{t.catalog.columns}</h3>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800/80 overflow-hidden bg-white dark:bg-slate-950/40">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 text-slate-600 dark:text-slate-400 font-mono font-semibold">
                    <tr>
                      <th className="py-2.5 px-3">Column Name</th>
                      <th className="py-2.5 px-3">Data Type</th>
                      <th className="py-2.5 px-3">Partition</th>
                      <th className="py-2.5 px-3">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800/60 font-mono">
                    {selectedTable.columns.map((col) => (
                      <tr key={col.name} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/20">
                        <td className="py-2.5 px-3 font-bold text-slate-900 dark:text-slate-200">{col.name}</td>
                        <td className="py-2.5 px-3 text-cyan-700 dark:text-cyan-400 font-semibold">{col.type}</td>
                        <td className="py-2.5 px-3">
                          {col.isPartition ? (
                            <span className="inline-flex items-center gap-1 text-[10px] text-amber-800 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-200 dark:border-transparent font-semibold">
                              <Key className="h-2.5 w-2.5" /> Partition
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-sans text-slate-600 dark:text-slate-400">{col.comment || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Sample Query Box */}
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-cyan-700 dark:text-cyan-400" /> Trino Query Template
                </span>
                <button
                  onClick={copySql}
                  className="flex items-center gap-1 text-xs text-slate-500 hover:text-cyan-700 dark:text-slate-400 dark:hover:text-cyan-300 font-mono font-medium transition-colors"
                >
                  {copied ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? '복사 완료' : 'SQL 복사'}
                </button>
              </div>
              <pre className="rounded-lg bg-slate-900 p-3.5 border border-slate-800 text-xs font-mono text-cyan-300/90 overflow-x-auto shadow-inner leading-relaxed">
                {sampleSql}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

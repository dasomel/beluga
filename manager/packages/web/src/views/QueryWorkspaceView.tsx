import React, { useState } from 'react';
import { Play, RotateCcw, ExternalLink, Terminal, CheckCircle2, Clock } from 'lucide-react';
import { Translations } from '../i18n/translations';

interface QueryWorkspaceViewProps {
  t: Translations;
}

interface PresetQuery {
  title: string;
  sql: string;
}

const presetQueries: PresetQuery[] = [
  {
    title: '주문 상태별 매출 합계 집계',
    sql: `SELECT \n  order_status,\n  COUNT(*) AS total_orders,\n  SUM(total_amount) AS revenue\nFROM beluga_lake.default.orders\nGROUP BY order_status\nORDER BY revenue DESC;`,
  },
  {
    title: '최근 완료된 주문 10건 조회',
    sql: `SELECT \n  order_id,\n  customer_id,\n  total_amount,\n  created_at\nFROM beluga_lake.default.orders\nWHERE order_status = 'COMPLETED'\nORDER BY created_at DESC\nLIMIT 10;`,
  },
  {
    title: 'Iceberg 테이블 스냅샷 메타데이터',
    sql: `SELECT \n  committed_at,\n  snapshot_id,\n  parent_id,\n  operation\nFROM beluga_lake.default."orders$snapshots"\nORDER BY committed_at DESC\nLIMIT 5;`,
  },
];

export const QueryWorkspaceView: React.FC<QueryWorkspaceViewProps> = ({ t }) => {
  const [sql, setSql] = useState(presetQueries[0]!.sql);
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(true);

  const mockResults = [
    { order_status: 'COMPLETED', total_orders: 8420, revenue: '124,530,000 KRW' },
    { order_status: 'PENDING', total_orders: 412, revenue: '6,180,000 KRW' },
    { order_status: 'CANCELLED', total_orders: 86, revenue: '1,290,000 KRW' },
  ];

  const handleRun = () => {
    setIsRunning(true);
    setTimeout(() => {
      setIsRunning(false);
      setHasRun(true);
    }, 450);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.query.title}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.query.subtitle}</p>
        </div>
        <a
          href="http://trino.local.beluga.internal"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white dark:bg-slate-900 px-3 py-2 text-xs font-bold text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors border border-slate-200 dark:border-slate-700 shadow-xs"
        >
          Trino 코디네이터 UI 열기
          <ExternalLink className="h-3.5 w-3.5 text-cyan-600 dark:text-cyan-400" />
        </a>
      </div>

      {/* Preset Pills */}
      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-slate-600 dark:text-slate-300 font-bold mr-1">{t.query.presetQueries}:</span>
        {presetQueries.map((preset) => (
          <button
            key={preset.title}
            onClick={() => setSql(preset.sql)}
            className="px-2.5 py-1 rounded-md text-xs font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-cyan-500 dark:hover:border-cyan-400 hover:text-cyan-700 dark:hover:text-cyan-300 transition-colors shadow-xs"
          >
            {preset.title}
          </button>
        ))}
      </div>

      {/* SQL Editor Area */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs backdrop-blur-sm">
        <div className="flex items-center justify-between px-4 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs">
          <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 font-mono font-bold">
            <Terminal className="h-4 w-4 text-cyan-700 dark:text-cyan-400" />
            <span>Trino SQL Editor &bull; catalog: beluga_lake &bull; schema: default</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSql('')}
              className="flex items-center gap-1 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white px-2 py-1 rounded hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors font-bold"
            >
              <RotateCcw className="h-3 w-3" /> 초기화
            </button>
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="flex items-center gap-1.5 rounded-md bg-cyan-600 hover:bg-cyan-500 dark:bg-cyan-500 dark:hover:bg-cyan-400 text-white dark:text-slate-950 font-bold px-3.5 py-1.5 transition-colors disabled:opacity-50 shadow-xs"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {isRunning ? '실행 중...' : t.query.runQuery}
            </button>
          </div>
        </div>

        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={7}
          className="w-full bg-slate-950 p-4 font-mono text-sm text-cyan-200 focus:outline-none resize-none selection:bg-cyan-500/40 leading-relaxed border-0"
          placeholder="-- Trino SQL 쿼리를 입력하세요..."
        />
      </div>

      {/* Results View */}
      {hasRun && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden shadow-xs backdrop-blur-sm">
          <div className="flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 text-xs">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400 font-bold">
              <CheckCircle2 className="h-4 w-4" />
              <span>Query Succeeded (Trino QueryId: 20260919_143100_00042_beluga)</span>
            </div>
            <div className="flex items-center gap-4 text-slate-600 dark:text-slate-300 font-mono font-medium">
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" /> 42 ms
              </span>
              <span className="font-bold">3 rows</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-700 dark:text-slate-300 font-bold">
                <tr>
                  <th className="py-2.5 px-4">order_status</th>
                  <th className="py-2.5 px-4 text-right">total_orders</th>
                  <th className="py-2.5 px-4 text-right">revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800/80 text-slate-800 dark:text-slate-100">
                {mockResults.map((row, idx) => (
                  <tr key={idx} className="hover:bg-slate-50 dark:hover:bg-slate-850/60">
                    <td className="py-2.5 px-4">
                      <span className="rounded bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-cyan-800 dark:text-cyan-300 font-bold border border-slate-200 dark:border-slate-700">
                        {row.order_status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right font-bold text-slate-900 dark:text-white">{row.total_orders.toLocaleString()}</td>
                    <td className="py-2.5 px-4 text-right text-emerald-700 dark:text-emerald-400 font-bold">{row.revenue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

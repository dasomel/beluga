import React, { useState } from 'react';
import { Layers, Link2, Clock } from 'lucide-react';
import { Translations } from '../i18n/translations';
import { usePipelines } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState, ErrorState } from '../components/QueryState';

interface PipelinesViewProps {
  t: Translations;
  initialPipelineId?: string;
}

export const PipelinesView: React.FC<PipelinesViewProps> = ({ t, initialPipelineId }) => {
  const pipelinesQuery = usePipelines();
  const pipelines = pipelinesQuery.data?.data ?? [];
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(initialPipelineId ?? null);

  const selectedPipeline = selectedPipelineId === null
    ? pipelines[0]
    : pipelines.find((pipeline) => pipeline.id === selectedPipelineId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.pipelines.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.pipelines.subtitle}</p>
      </div>

      {pipelinesQuery.isLoading && <LoadingState t={t} />}
      {!pipelinesQuery.isLoading && pipelinesQuery.isError && <ErrorState t={t} error={pipelinesQuery.error} />}

      {!pipelinesQuery.isLoading && !pipelinesQuery.isError && (
        <>
          {selectedPipelineId !== null && !selectedPipeline && (
            <p role="status" className="text-sm text-slate-500 dark:text-slate-400">
              {t.pipelines.notFound}: <span className="font-mono">{selectedPipelineId}</span>
            </p>
          )}
          {/* Pipeline Topology Canvas */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-cyan-700 dark:text-cyan-400" />
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.pipelines.topologyTitle}</h2>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {pipelines.map((pipeline) => {
                const isSelected = selectedPipeline?.id === pipeline.id;
                return (
                  <div
                    key={pipeline.id}
                    onClick={() => setSelectedPipelineId(pipeline.id)}
                    className={`group relative cursor-pointer rounded-xl border p-4 transition-all ${
                      isSelected
                        ? 'border-cyan-500 bg-cyan-50/90 dark:border-cyan-400 dark:bg-cyan-950 dark:ring-2 dark:ring-cyan-400/50 shadow-md'
                        : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-100/80 dark:hover:bg-slate-850'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2 gap-2">
                      <span className="text-xs font-bold text-slate-900 dark:text-white group-hover:text-cyan-800 dark:group-hover:text-cyan-300 transition-colors line-clamp-1">
                        {pipeline.name}
                      </span>
                      <StatusBadge status={pipeline.status} t={t} />
                    </div>

                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 font-medium">
                      {pipeline.stages.length} {t.pipelines.stagesLabel.toLowerCase()}
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] space-y-1">
                      <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                        <span className="flex items-center gap-1">
                          <Link2 className="h-3 w-3" /> {t.pipelines.correlationLabel}:
                        </span>
                        <span className="font-mono font-bold text-slate-900 dark:text-white">{pipeline.correlation.method}</span>
                      </div>
                      <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                        <span>{t.pipelines.confidenceLabel}:</span>
                        <span className="font-mono font-bold text-slate-900 dark:text-white">
                          {Math.round(pipeline.correlation.confidence * 100)}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Selected Pipeline Drill-Down Detail */}
          {selectedPipeline && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
              <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                <div>
                  <span className="text-xs font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">
                    {selectedPipeline.id}
                  </span>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedPipeline.name}</h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono font-medium flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    {t.pipelines.lastUpdatedLabel}: {new Date(selectedPipeline.lastUpdatedAt).toLocaleString()}
                  </p>
                </div>
                <StatusBadge status={selectedPipeline.status} t={t} />
              </div>

              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-3">
                {t.pipelines.stagesLabel}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {selectedPipeline.stages.map((stage) => (
                  <div key={stage.serviceId} className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-white font-mono">{stage.serviceType}</span>
                      <StatusBadge status={stage.status} t={t} />
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-300 font-mono font-medium">{stage.serviceId}</div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 font-medium">
                      {stage.detail ?? t.pipelines.noStageDetail}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

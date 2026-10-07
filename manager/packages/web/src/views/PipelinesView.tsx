import React, { useMemo, useState } from 'react';
import { Clock, ExternalLink, Layers, Link2 } from 'lucide-react';
import type { HealthStatus, Pipeline, PipelineJob } from '@beluga-manager/domain-api/schema';
import { Translations, type Locale } from '../i18n/translations';
import { formatDateTime } from '../i18n/format';
import { usePipelines, useServices } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState, ErrorState } from '../components/QueryState';
import { TopologyGraph, type TopologyGraphNode, type TopologyGraphEdge } from '../components/graph';
import { getStageExternalUrl } from './pipelineStageLinks';

/**
 * Status mapping for correlation-graph nodes (D4: never show "healthy" without evidence).
 *
 * 1. Node refers to a job (job.id or job.name equals the reference id) -> from `job.lastRun.result`:
 *    succeeded -> healthy, running -> healthy, failed -> degraded, unknown -> unknown;
 *    no `lastRun` (never reported) -> unknown.
 * 2. Node refers to a pipeline stage by EXACT serviceId -> that stage's status.
 * 3. Anything else (e.g. a Kafka topic or Iceberg table: the stage status is the health of the
 *    whole service, not of that object) -> unknown. No service-type guessing.
 * "unknown" is rendered by StatusBadge with the text label and a distinct icon, never colour alone.
 */
export function inferJobStatus(job: PipelineJob): HealthStatus {
  const result = job.lastRun?.result;
  if (result === 'succeeded' || result === 'running') return 'healthy';
  if (result === 'failed') return 'degraded';
  return 'unknown';
}

export function inferCorrelationNodeStatus(
  pipeline: Pick<Pipeline, 'stages' | 'jobs'>,
  referenceId: string,
): { status: HealthStatus; detail: string | null } {
  const job = pipeline.jobs.find((j) => j.id === referenceId || j.name === referenceId);
  if (job) {
    return { status: inferJobStatus(job), detail: job.lastRun?.failureReason ?? null };
  }
  const stage = pipeline.stages.find((s) => s.serviceId === referenceId);
  if (stage) {
    return { status: stage.status, detail: stage.detail };
  }
  return { status: 'unknown', detail: null };
}

export function buildPipelineCorrelationGraph(
  pipeline: Pipeline,
  t: Translations,
): { nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[] } {
  if (!pipeline.correlationLinks || pipeline.correlationLinks.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeMap = new Map<string, TopologyGraphNode>();
  const edges: TopologyGraphEdge[] = [];

  for (const link of pipeline.correlationLinks) {
    const sourceKey = `${link.source.kind}:${link.source.id}`;
    const targetKey = `${link.target.kind}:${link.target.id}`;

    if (!nodeMap.has(sourceKey)) {
      const { status, detail } = inferCorrelationNodeStatus(pipeline, link.source.id);
      nodeMap.set(sourceKey, {
        id: sourceKey,
        title: t.pipelines.correlationKinds[link.source.kind] ?? link.source.kind,
        subtitle: link.source.id,
        badge: link.source.kind,
        status,
        detail,
      });
    }

    if (!nodeMap.has(targetKey)) {
      const { status, detail } = inferCorrelationNodeStatus(pipeline, link.target.id);
      nodeMap.set(targetKey, {
        id: targetKey,
        title: t.pipelines.correlationKinds[link.target.kind] ?? link.target.kind,
        subtitle: link.target.id,
        badge: link.target.kind,
        status,
        detail,
      });
    }

    edges.push({
      id: link.id,
      source: sourceKey,
      target: targetKey,
      label: t.pipelines.correlationRelations[link.relation] ?? link.relation,
      confidence: link.confidence,
      method: link.method,
      dashed: link.method !== 'declared-label',
      evidence: link.evidence,
    });
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges,
  };
}

interface PipelinesViewProps {
  t: Translations;
  locale?: Locale;
  initialPipelineId?: string;
  theme: 'light' | 'dark';
}

export const PipelinesView: React.FC<PipelinesViewProps> = ({ t, locale = 'en-US', initialPipelineId, theme }) => {
  const pipelinesQuery = usePipelines();
  const servicesQuery = useServices();
  const pipelines = pipelinesQuery.data?.data ?? [];
  const services = servicesQuery.data?.data ?? [];
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(initialPipelineId ?? null);

  const selectedPipeline = selectedPipelineId === null
    ? pipelines[0]
    : pipelines.find((pipeline) => pipeline.id === selectedPipelineId);

  const correlationGraph = useMemo(
    () => (selectedPipeline ? buildPipelineCorrelationGraph(selectedPipeline, t) : { nodes: [], edges: [] }),
    [selectedPipeline, t],
  );

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
                    {t.pipelines.lastUpdatedLabel}: {formatDateTime(selectedPipeline.lastUpdatedAt, locale)}
                  </p>
                </div>
                <StatusBadge status={selectedPipeline.status} t={t} />
              </div>

              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-3">
                {t.pipelines.stagesLabel}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {selectedPipeline.stages.map((stage) => {
                  const externalUrl = getStageExternalUrl(stage.serviceId, services);
                  return (
                    <div key={stage.serviceId} className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-sm font-bold text-slate-900 dark:text-white font-mono">{stage.serviceType}</span>
                        <StatusBadge status={stage.status} t={t} />
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-300 font-mono font-medium">{stage.serviceId}</div>
                      {externalUrl && (
                        <a href={externalUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 hover:text-cyan-900 dark:text-cyan-400 dark:hover:text-cyan-300">
                          {t.services.openUi} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>
                      )}
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-2 font-medium">
                        {stage.detail ?? t.pipelines.noStageDetail}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="mt-6 mb-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mb-3">
                  {t.pipelines.correlationGraphTitle}
                </h4>
                <TopologyGraph
                  t={t}
                  theme={theme}
                  nodes={correlationGraph.nodes}
                  edges={correlationGraph.edges}
                  emptyMessage={t.pipelines.noCorrelationLinks}
                  height={320}
                />
              </div>

              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mt-6 mb-3">
                {t.pipelines.correlationLinksLabel}
              </h4>
              {selectedPipeline.correlationLinks.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t.pipelines.noCorrelationLinks}</p>
              ) : (
                <ul className="space-y-3">
                  {selectedPipeline.correlationLinks.map((link) => (
                    <li key={link.id} className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                          {t.pipelines.correlationRelations[link.relation]}
                        </span>
                        <span className="text-xs font-mono font-bold text-slate-900 dark:text-white">
                          {t.pipelines.correlationMethods[link.method]} · {Math.round(link.confidence * 100)}%
                        </span>
                      </div>
                      <div className="text-sm font-mono font-bold text-slate-900 dark:text-white">
                        {t.pipelines.correlationKinds[link.source.kind]} {link.source.id} → {t.pipelines.correlationKinds[link.target.kind]} {link.target.id}
                      </div>
                      {link.method !== 'declared-label' && (
                        <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-400">{t.pipelines.lowConfidence}</p>
                      )}
                      {link.evidence.length > 0 && (
                        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                          {t.pipelines.evidenceLabel}: {link.evidence.join('; ')}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 mt-6 mb-3">
                {t.pipelines.jobsLabel}
              </h4>
              {selectedPipeline.jobs.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-slate-400">{t.pipelines.noJobs}</p>
              ) : (
                <ul className="space-y-3">
                  {selectedPipeline.jobs.map((job) => {
                    const jobUrl = getStageExternalUrl(job.serviceId, services);
                    return (
                      <li key={job.id} className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-bold text-slate-900 dark:text-white font-mono">{job.name}</span>
                          <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">
                            {t.pipelines.jobKinds[job.kind]}
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                          {t.pipelines.lastRunLabel}:{' '}
                          {job.lastRun === null ? (
                            t.pipelines.noRuns
                          ) : (
                            <>
                              <span className="font-bold">{t.pipelines.runResults[job.lastRun.result]}</span>
                              {' · '}
                              <span className="font-mono">{formatDateTime(job.lastRun.startedAt, locale)}</span>
                            </>
                          )}
                        </div>
                        {job.lastRun?.result === 'failed' && job.lastRun.failureReason && (
                          <p role="alert" className="mt-1 text-xs font-medium text-rose-700 dark:text-rose-400">
                            {t.pipelines.failureReasonLabel}: {job.lastRun.failureReason}
                          </p>
                        )}
                        {job.relatedResourceIds.length > 0 && (
                          <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
                            {t.pipelines.relatedResourcesLabel}: {job.relatedResourceIds.join(', ')}
                          </div>
                        )}
                        {jobUrl && (
                          <a href={jobUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 hover:text-cyan-900 dark:text-cyan-400 dark:hover:text-cyan-300">
                            {t.services.openUi} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

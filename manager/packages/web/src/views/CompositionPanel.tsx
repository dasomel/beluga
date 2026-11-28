import React, { useMemo, useState } from 'react';
import { ExternalLink, MousePointerClick, X } from 'lucide-react';
import type { ListWarning, Resource, Service } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';
import { StatusBadge } from '../components/StatusBadge';
import { WarningsBadge } from '../components/WarningsBadge';
import {
  TopologyGraph,
  type TopologyGraphNode,
  type TopologyGraphEdge,
  GRAPH_NODE_WIDTH,
  GRAPH_NODE_HEIGHT,
  GRAPH_EDGE_ACCENT_BORDER_CLASS,
} from '../components/graph';
import type { EventNavigationTarget } from './eventNavigation';
import { getInfraResourceTarget } from './infraTopology';
import { getSafeExternalUrl } from './safeExternalUrl';
import {
  COMPOSITION_COMPONENTS,
  COMPOSITION_FLOWS,
  COMPOSITION_FLOW_ACCENT,
  compositionSummary,
  resolveComposition,
  type CompositionFlowKind,
  type CompositionNodeState,
} from './platformComposition';

/** Grid spacing: no edge labels on the canvas, so columns can sit closer than the default layout. */
export const COMPOSITION_GAP_X = 48;
export const COMPOSITION_GAP_Y = 40;
const FLOW_KINDS: readonly CompositionFlowKind[] = ['data', 'query', 'auth'];

interface CompositionPanelProps {
  t: Translations;
  theme: 'light' | 'dark';
  services: readonly Service[];
  resources: readonly Resource[];
  /** Upstream warnings from both lists, shown as a badge. */
  serviceWarnings?: readonly ListWarning[];
  resourceWarnings?: readonly ListWarning[];
  /** Resources list is incomplete (warnings or a truncated page): no absence can be claimed. */
  resourcesIncomplete?: boolean;
  onNavigateToEventTarget: (target: EventNavigationTarget) => void;
}

/**
 * Label for a component workload that the resources list did not report. Only a completely read
 * namespace proves absence ("not reported"); otherwise it is a blind spot ("not observed").
 */
export function unreportedWorkloadLabel(state: Pick<CompositionNodeState, 'namespaceRead'>, t: Translations): string {
  return state.namespaceRead ? t.architecture.compositionNotReported : t.architecture.compositionUnobserved;
}

/** Pure graph construction (positions, status, declared edges), exported for tests. */
export function buildCompositionGraph(
  states: readonly CompositionNodeState[],
  t: Translations,
): { nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[] } {
    const graphNodes = states.map((state) => {
      const { column, row } = state.component.cell;
      return {
        id: state.component.id,
        title: state.component.name,
        subtitle: t.architecture.compositionLayers[state.component.layer],
        badge: state.component.namespace,
        // Unobserved components carry no status at all, so nothing implies they are healthy.
        status: state.source === 'unobserved' ? undefined : state.status,
        detail:
          state.source === 'unobserved'
            ? t.architecture.compositionUnobserved
            : state.source === 'missing'
              ? t.architecture.compositionSources.missing
              : null,
        position: { x: column * (GRAPH_NODE_WIDTH + COMPOSITION_GAP_X), y: row * (GRAPH_NODE_HEIGHT + COMPOSITION_GAP_Y) },
        data: { componentId: state.component.id },
      } satisfies TopologyGraphNode;
    });
    const graphEdges = COMPOSITION_FLOWS.map((flow) => ({
      id: `${flow.source}->${flow.target}`,
      source: flow.source,
      target: flow.target,
      // The kind stays in the accessible name and the table view; the canvas shows it as colour.
      label: t.architecture.compositionFlowKinds[flow.kind],
      hideLabel: true,
      accent: COMPOSITION_FLOW_ACCENT[flow.kind],
      // Declared design, never observed by Manager: dashed, and never animated like live traffic.
      dashed: true,
      animated: false,
    }));
    return { nodes: graphNodes, edges: graphEdges };
}

export const CompositionPanel: React.FC<CompositionPanelProps> = ({
  t,
  theme,
  services,
  resources,
  serviceWarnings = [],
  resourceWarnings = [],
  resourcesIncomplete = false,
  onNavigateToEventTarget,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const states = useMemo(
    () => resolveComposition(services, resources, undefined, resourcesIncomplete || resourceWarnings.length > 0),
    [services, resources, resourcesIncomplete, resourceWarnings.length],
  );
  const warnings = useMemo(() => [...serviceWarnings, ...resourceWarnings], [serviceWarnings, resourceWarnings]);
  const summary = useMemo(() => compositionSummary(states), [states]);
  const selected: CompositionNodeState | null = states.find((state) => state.component.id === selectedId) ?? null;

  const { nodes, edges } = useMemo(() => buildCompositionGraph(states, t), [states, t]);

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">{t.architecture.compositionHint}</p>
        <WarningsBadge warnings={warnings} t={t} />
      </div>
      <dl className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" aria-label={t.architecture.compositionSummaryLabel}>
        {(['service', 'resources', 'missing', 'unobserved'] as const).map((source) => (
          <div key={source} className="rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2">
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {t.architecture.compositionSources[source]}
            </dt>
            <dd className="mt-0.5 font-mono font-bold text-slate-900 dark:text-white" data-testid={`composition-count-${source}`}>
              {summary[source]}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-medium mb-3">
        <MousePointerClick className="h-3.5 w-3.5" />
        {t.architecture.clickNodeHint}
      </div>
      <div className="relative">
        <TopologyGraph
          t={t}
          theme={theme}
          nodes={nodes}
          edges={edges}
          selectedNodeId={selectedId}
          onSelectNode={setSelectedId}
          height={480}
          minZoom={0.2}
          fitViewPadding={0.06}
          ariaLabel={t.architecture.currentComposition}
        />

        {selected && (
          <div className="absolute top-12 right-0 z-10 h-[480px] w-80 max-w-[85%] border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 overflow-y-auto rounded-r-lg">
            <div className="flex items-start justify-between gap-2 mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">
                  {t.architecture.compositionLayers[selected.component.layer]}
                </span>
                <h3 className="text-base font-bold text-slate-900 dark:text-white mt-0.5">{selected.component.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                aria-label={t.architecture.closeLabel}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">{t.common.status}</div>
                {selected.source === 'unobserved' ? (
                  <div className="font-medium text-slate-600 dark:text-slate-300">{t.architecture.compositionUnobserved}</div>
                ) : (
                  <StatusBadge status={selected.status} t={t} />
                )}
                <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  {t.architecture.compositionSourceLabel}: {t.architecture.compositionSources[selected.source]}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                  {t.operations.namespaceLabel}
                </div>
                <div className="font-mono font-bold text-slate-900 dark:text-white">{selected.component.namespace}</div>
              </div>
              {selected.component.workloads.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                    {t.architecture.compositionWorkloads}
                  </div>
                  <ul className="space-y-1">
                    {selected.component.workloads.map((ref) => {
                      const live = selected.resources.find((resource) => resource.id.endsWith(`/${ref}`));
                      return (
                        <li key={ref} className="flex items-center justify-between gap-2">
                          <span className="font-mono text-slate-800 dark:text-slate-200 break-all">{ref}</span>
                          {live ? (
                            <button
                              type="button"
                              onClick={() => onNavigateToEventTarget(getInfraResourceTarget(live))}
                              className="shrink-0 text-[11px] font-bold text-cyan-800 dark:text-cyan-300 hover:underline"
                            >
                              {t.architecture.openResource}
                            </button>
                          ) : (
                            <span className="shrink-0 text-[11px] text-slate-400">{unreportedWorkloadLabel(selected, t)}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {selected.component.reads && selected.component.reads.length > 0 && (
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                    {t.architecture.compositionReads}
                  </div>
                  <ul className="flex flex-wrap gap-1.5">
                    {selected.component.reads.map((id) => (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(id)}
                          className="rounded-md border border-slate-200 dark:border-slate-700 px-2 py-0.5 font-mono text-[11px] font-bold text-cyan-800 dark:text-cyan-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                        >
                          {COMPOSITION_COMPONENTS.find((component) => component.id === id)?.name ?? id}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selected.service && (
                <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
                  <button
                    type="button"
                    onClick={() => onNavigateToEventTarget({ tab: 'services', id: selected.service!.id })}
                    className="w-full rounded-lg border border-cyan-200 dark:border-cyan-800 bg-cyan-50 dark:bg-cyan-950/50 px-3 py-2 text-left text-xs font-bold text-cyan-900 dark:text-cyan-200 hover:bg-cyan-100 dark:hover:bg-cyan-900/60 transition-colors"
                  >
                    {t.architecture.openService}
                  </button>
                </div>
              )}
              {selected.endpoint && getSafeExternalUrl(selected.endpoint) && (
                <a
                  href={getSafeExternalUrl(selected.endpoint)!}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-cyan-800 dark:text-cyan-300 hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {selected.endpoint}
                </a>
              )}
            </div>
          </div>
        )}
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-medium text-slate-600 dark:text-slate-300" aria-label={t.architecture.compositionFlowLegendLabel}>
        {FLOW_KINDS.map((kind) => (
          <li key={kind} className="inline-flex items-center gap-1.5" data-testid={`composition-flow-legend-${kind}`}>
            <span aria-hidden="true" className={`inline-block w-6 border-t-2 border-dashed ${GRAPH_EDGE_ACCENT_BORDER_CLASS[COMPOSITION_FLOW_ACCENT[kind]]}`} />
            {t.architecture.compositionFlowKinds[kind]}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">{t.architecture.compositionLegend}</p>
    </div>
  );
};

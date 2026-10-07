import React, { useMemo, useState } from 'react';
import { MousePointerClick, X } from 'lucide-react';
import type { Resource } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';
import { StatusBadge } from '../components/StatusBadge';
import {
  TopologyGraph,
  type TopologyGraphNode,
  type TopologyGraphEdge,
  GRAPH_NODE_WIDTH,
  GRAPH_NODE_HEIGHT,
  GRAPH_GAP_X,
  GRAPH_GAP_Y,
} from '../components/graph';
import type { EventNavigationTarget } from './eventNavigation';
import { buildInfraTopology, getInfraResourceTarget } from './infraTopology';

interface InfraTopologyPanelProps {
  t: Translations;
  theme: 'light' | 'dark';
  resources: readonly Resource[];
  onNavigateToEventTarget: (target: EventNavigationTarget) => void;
}

export const InfraTopologyPanel: React.FC<InfraTopologyPanelProps> = ({
  t,
  theme,
  resources,
  onNavigateToEventTarget,
}) => {
  const [selected, setSelected] = useState<Resource | null>(null);

  const { nodes, edges } = useMemo<{ nodes: TopologyGraphNode[]; edges: TopologyGraphEdge[] }>(() => {
    const topology = buildInfraTopology(resources);
    return {
      nodes: topology.nodes.map((node) => ({
        id: node.id,
        title: node.resource.kind,
        subtitle: node.resource.name,
        badge: node.resource.namespace ?? undefined,
        status: node.resource.status,
        position: {
          x: node.column * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
          y: node.row * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
        },
        data: { resource: node.resource },
      })),
      edges: topology.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    };
  }, [resources]);

  if (resources.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-sm text-slate-500 dark:text-slate-400 font-medium">
        {t.architecture.infrastructureEmpty}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
      <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mb-3">{t.architecture.infrastructureHint}</p>
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
          selectedNodeId={selected?.id ?? null}
          onSelectNode={(nodeId) => {
            if (!nodeId) {
              setSelected(null);
            } else {
              const res = resources.find((r) => r.id === nodeId);
              setSelected(res ?? null);
            }
          }}
          height={420}
          emptyMessage={t.architecture.infrastructureEmpty}
        />

        {selected && (
          <div className="absolute top-12 right-0 z-10 h-[420px] w-80 max-w-[85%] border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 overflow-y-auto rounded-r-lg">
            <div className="flex items-start justify-between gap-2 mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
              <div>
                <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">
                  {t.architecture.resourceDetailTitle}
                </span>
                <h3 className="text-base font-bold text-slate-900 dark:text-white font-mono mt-0.5">{selected.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label={t.architecture.closeLabel}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 text-xs">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                  {t.operations.kindLabel}
                </div>
                <div className="font-mono font-bold text-slate-900 dark:text-white">{selected.kind}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                  {t.operations.namespaceLabel}
                </div>
                <div className="font-mono font-bold text-slate-900 dark:text-white">{selected.namespace ?? '-'}</div>
              </div>
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                  {t.common.status}
                </div>
                <StatusBadge status={selected.status} t={t} />
              </div>
              <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
                <button
                  type="button"
                  onClick={() => onNavigateToEventTarget(getInfraResourceTarget(selected))}
                  className="w-full rounded-lg border border-cyan-200 dark:border-cyan-800 bg-cyan-50 dark:bg-cyan-950/50 px-3 py-2 text-left text-xs font-bold text-cyan-900 dark:text-cyan-200 hover:bg-cyan-100 dark:hover:bg-cyan-900/60 transition-colors"
                >
                  {t.architecture.openResource}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

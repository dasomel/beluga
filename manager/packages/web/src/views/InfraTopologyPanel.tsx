import React, { useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MousePointerClick, X } from 'lucide-react';
import type { Resource } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';
import { StatusBadge } from '../components/StatusBadge';
import type { EventNavigationTarget } from './eventNavigation';
import { buildInfraTopology, getInfraResourceTarget } from './infraTopology';

type ResourceNodeData = { resource: Resource; t: Translations; isSelected: boolean };
type ResourceNode = Node<ResourceNodeData, 'resource'>;

const NODE_WIDTH = 220;
const NODE_GAP_X = 90;
const NODE_HEIGHT = 96;
const NODE_GAP_Y = 24;
const EDGE_COLOR = '#94a3b8'; // slate-400, legible on both light and dark canvas

function ResourceFlowNode({ data }: NodeProps<ResourceNode>) {
  const { resource, t, isSelected } = data;
  return (
    <div
      className={`w-[220px] rounded-xl border bg-white dark:bg-slate-900 p-3.5 shadow-xs transition-colors ${
        isSelected
          ? 'border-cyan-500 dark:border-cyan-400 ring-2 ring-cyan-400/40'
          : 'border-slate-200 dark:border-slate-700'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!bg-slate-400 dark:!bg-slate-500" />
      <div className="text-xs font-bold uppercase tracking-wide text-slate-900 dark:text-white font-mono mb-1.5">
        {resource.kind}
      </div>
      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 font-medium mb-2.5 truncate">
        {resource.name}
      </div>
      <StatusBadge status={resource.status} t={t} />
      <Handle type="source" position={Position.Right} className="!bg-slate-400 dark:!bg-slate-500" />
    </div>
  );
}

const nodeTypes: NodeTypes = { resource: ResourceFlowNode };

interface InfraTopologyPanelProps {
  t: Translations;
  theme: 'light' | 'dark';
  resources: readonly Resource[];
  onNavigateToEventTarget: (target: EventNavigationTarget) => void;
}

export const InfraTopologyPanel: React.FC<InfraTopologyPanelProps> = ({ t, theme, resources, onNavigateToEventTarget }) => {
  const [selected, setSelected] = useState<Resource | null>(null);

  const { nodes, edges } = useMemo<{ nodes: ResourceNode[]; edges: Edge[] }>(() => {
    const topology = buildInfraTopology(resources);
    return {
      nodes: topology.nodes.map((node) => ({
        id: node.id,
        type: 'resource',
        position: { x: node.column * (NODE_WIDTH + NODE_GAP_X), y: node.row * (NODE_HEIGHT + NODE_GAP_Y) },
        data: { resource: node.resource, t, isSelected: node.id === selected?.id },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      })),
      edges: topology.edges.map((edge) => ({
        ...edge,
        type: 'smoothstep',
        style: { stroke: EDGE_COLOR, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR },
      })),
    };
  }, [resources, t, selected]);

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
      <div className="relative h-[420px] rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-950">
        <ReactFlow<ResourceNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelected(node.data.resource)}
          onPaneClick={() => setSelected(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          zoomOnDoubleClick={false}
          colorMode={theme}
          fitView
          fitViewOptions={{ padding: 0.3 }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>

        {selected && (
          <div className="absolute top-0 right-0 z-10 h-full w-80 max-w-[85%] border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 overflow-y-auto">
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

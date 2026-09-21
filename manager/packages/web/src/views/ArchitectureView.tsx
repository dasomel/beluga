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
import { Workflow, Boxes, Construction, MousePointerClick, X } from 'lucide-react';
import type { Pipeline, PipelineStage } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';
import { usePipelines } from '../api/hooks';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState, ErrorState } from '../components/QueryState';

interface ArchitectureViewProps {
  t: Translations;
  theme: 'light' | 'dark';
}

type StageNodeData = {
  stage: PipelineStage;
  t: Translations;
  isSelected: boolean;
};

type StageNode = Node<StageNodeData, 'stage'>;

// Keep in sync with the `w-[220px]` class on the node body below -- Tailwind needs the
// literal class for its scanner, so it can't reference this constant directly.
const NODE_WIDTH = 220;
const NODE_GAP_X = 90;
const EDGE_COLOR = '#94a3b8'; // slate-400, legible on both light and dark canvas

function stageNodeId(pipelineId: string, serviceId: string): string {
  return `${pipelineId}::${serviceId}`;
}

function buildGraph(
  pipeline: Pipeline,
  t: Translations,
  selectedServiceId: string | null,
): { nodes: StageNode[]; edges: Edge[] } {
  const nodes: StageNode[] = pipeline.stages.map((stage, index) => ({
    id: stageNodeId(pipeline.id, stage.serviceId),
    type: 'stage',
    position: { x: index * (NODE_WIDTH + NODE_GAP_X), y: 0 },
    data: { stage, t, isSelected: stage.serviceId === selectedServiceId },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));

  const edges: Edge[] = pipeline.stages.slice(0, -1).map((stage, index) => {
    const next = pipeline.stages[index + 1]!;
    return {
      id: `${stageNodeId(pipeline.id, stage.serviceId)}->${stageNodeId(pipeline.id, next.serviceId)}`,
      source: stageNodeId(pipeline.id, stage.serviceId),
      target: stageNodeId(pipeline.id, next.serviceId),
      type: 'smoothstep',
      style: { stroke: EDGE_COLOR, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLOR },
    };
  });

  return { nodes, edges };
}

function StageFlowNode({ data }: NodeProps<StageNode>) {
  const { stage, t, isSelected } = data;
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
        {stage.serviceType}
      </div>
      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 font-medium mb-2.5 truncate">
        {stage.serviceId}
      </div>
      <StatusBadge status={stage.status} t={t} />
      <Handle type="source" position={Position.Right} className="!bg-slate-400 dark:!bg-slate-500" />
    </div>
  );
}

const nodeTypes: NodeTypes = { stage: StageFlowNode };

export const ArchitectureView: React.FC<ArchitectureViewProps> = ({ t, theme }) => {
  const pipelinesQuery = usePipelines();
  const pipelines = pipelinesQuery.data?.data ?? [];
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(null);
  const [selectedStage, setSelectedStage] = useState<PipelineStage | null>(null);

  const selectedPipeline = pipelines.find((pipeline) => pipeline.id === selectedPipelineId) ?? pipelines[0];

  const { nodes, edges } = useMemo<{ nodes: StageNode[]; edges: Edge[] }>(
    () =>
      selectedPipeline
        ? buildGraph(selectedPipeline, t, selectedStage?.serviceId ?? null)
        : { nodes: [], edges: [] },
    [selectedPipeline, t, selectedStage],
  );

  const selectPipeline = (id: string) => {
    setSelectedPipelineId(id);
    setSelectedStage(null);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.architecture.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.architecture.subtitle}</p>
      </div>

      {/* Perspective Switcher -- clearly separates the two viewpoints the issue asks for */}
      <div className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1.5 shadow-xs">
        <span className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/50">
          <Workflow className="h-4 w-4" />
          {t.architecture.dataPipelineTopology}
        </span>
        {/* TODO(#18): Infrastructure Topology (K8s namespace/workload/service/storage) plugs in
            here once domain-api exposes those concepts -- out of scope for this MVP slice. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t.architecture.infrastructureHint}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-slate-400 dark:text-slate-500 cursor-not-allowed"
        >
          <Boxes className="h-4 w-4" />
          {t.architecture.infrastructureTopology}
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-500 dark:text-slate-400">
            <Construction className="h-2.5 w-2.5" />
            {t.architecture.comingSoon}
          </span>
        </button>
      </div>

      {pipelinesQuery.isLoading && <LoadingState t={t} />}
      {!pipelinesQuery.isLoading && pipelinesQuery.isError && <ErrorState t={t} error={pipelinesQuery.error} />}

      {!pipelinesQuery.isLoading && !pipelinesQuery.isError && selectedPipeline && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
          {/* Pipeline selector -- every pipeline must be viewable, not just the first */}
          <div className="flex flex-wrap items-center gap-2 mb-5">
            {pipelines.map((pipeline) => {
              const isActive = pipeline.id === selectedPipeline.id;
              return (
                <button
                  key={pipeline.id}
                  type="button"
                  onClick={() => selectPipeline(pipeline.id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${
                    isActive
                      ? 'border-cyan-500 bg-cyan-50 dark:border-cyan-400 dark:bg-cyan-950 text-cyan-900 dark:text-cyan-200 shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-600'
                  }`}
                >
                  {pipeline.name}
                  <StatusBadge status={pipeline.status} t={t} />
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-medium mb-3">
            <MousePointerClick className="h-3.5 w-3.5" />
            {t.architecture.clickNodeHint}
          </div>

          {/* Graph canvas + drill-down panel */}
          <div className="relative h-[420px] rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-950">
            <ReactFlow<StageNode>
              key={selectedPipeline.id}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_, node) => setSelectedStage(node.data.stage)}
              onPaneClick={() => setSelectedStage(null)}
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

            {selectedStage && (
              <div className="absolute top-0 right-0 z-10 h-full w-80 max-w-[85%] border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl p-5 overflow-y-auto">
                <div className="flex items-start justify-between gap-2 mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">
                      {t.architecture.stageDetailTitle}
                    </span>
                    <h3 className="text-base font-bold text-slate-900 dark:text-white font-mono mt-0.5">
                      {selectedStage.serviceType}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedStage(null)}
                    aria-label={t.architecture.closeLabel}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="space-y-4 text-xs">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                      {t.architecture.serviceIdLabel}
                    </div>
                    <div className="font-mono font-bold text-slate-900 dark:text-white">{selectedStage.serviceId}</div>
                  </div>

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                      {t.common.status}
                    </div>
                    <StatusBadge status={selectedStage.status} t={t} />
                  </div>

                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                      {t.architecture.detailLabel}
                    </div>
                    <p className="text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
                      {selectedStage.detail ?? t.pipelines.noStageDetail}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

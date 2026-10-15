import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MarkerType,
  type Edge,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Layout, Table as TableIcon, Keyboard } from 'lucide-react';
import { interpolate } from '../../i18n/interpolate';
import { StatusBadge } from '../StatusBadge';
import { LoadingState, ErrorState } from '../QueryState';
import { TopologyFlowNode, type TopologyFlowNodeType } from './TopologyFlowNode';
import { computeGraphLayout } from './layout';
import { findNextNodeId, isNavigationKey, resolveActiveNodeId } from './navigation';
import { hasGraphDataIssues, sanitizeGraph } from './sanitize';
import {
  GRAPH_TOKENS,
  MIN_TARGET_CLASS,
  buildLiveSummary,
  edgeAriaLabel,
  nodeDisplayName,
  shouldAnimateEdge,
} from './theme';
import type { TopologyGraphNode, TopologyGraphProps } from './types';

const nodeTypes: NodeTypes = { topology: TopologyFlowNode };

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(REDUCED_MOTION_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
}

export const TopologyGraph: React.FC<TopologyGraphProps> = ({
  t,
  theme = 'light',
  nodes: rawNodes,
  edges: rawEdges,
  selectedNodeId = null,
  onSelectNode,
  isLoading = false,
  error = null,
  emptyMessage,
  height = 420,
  className = '',
  ariaLabel,
}) => {
  const [viewMode, setViewMode] = useState<'graph' | 'table'>('graph');

  // Graph and table both render from this one sanitized dataset so they cannot drift apart.
  const sanitized = useMemo(() => sanitizeGraph(rawNodes, rawEdges), [rawNodes, rawEdges]);
  const { nodes, edges } = sanitized;
  const prefersReducedMotion = usePrefersReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const edgeColor = GRAPH_TOKENS[theme].edge;

  const layoutPositions = useMemo(
    () => computeGraphLayout(nodes, edges),
    [nodes, edges],
  );

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n] as const)), [nodes]);
  const tabStopId = resolveActiveNodeId(
    nodes.map((n) => n.id),
    activeId,
    selectedNodeId,
  );

  const flowNodes = useMemo<TopologyFlowNodeType[]>(() => {
    return nodes.map((node) => {
      const pos = layoutPositions.get(node.id) ?? node.position ?? { x: 0, y: 0 };
      return {
        id: node.id,
        type: 'topology',
        position: pos,
        // The inner element is the single focusable; the xyflow wrapper is neutral (no tabindex,
        // no "group" role, no roledescription) so a node is one Tab-stop-candidate, not two.
        focusable: false,
        ariaRole: 'presentation',
        domAttributes: { 'aria-roledescription': undefined },
        data: {
          node,
          t,
          isSelected: selectedNodeId === node.id,
          isTabStop: tabStopId === node.id,
          interactive: onSelectNode !== undefined,
          onSelect: onSelectNode,
          onFocusNode: setActiveId,
        },
      };
    });
  }, [nodes, layoutPositions, selectedNodeId, tabStopId, onSelectNode, t]);

  const flowEdges = useMemo<Edge[]>(() => {
    return edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: 'smoothstep',
      focusable: false,
      ariaLabel: edgeAriaLabel(t, edge, nodeById),
      animated: shouldAnimateEdge(edge.dashed, prefersReducedMotion),
      style: {
        stroke: edgeColor,
        strokeWidth: 2,
        strokeDasharray: edge.dashed ? '5,5' : undefined,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: edgeColor,
      },
    }));
  }, [edges, edgeColor, prefersReducedMotion, nodeById, t]);

  // Spatial arrow-key navigation, scoped to THIS graph's container (never `document`).
  const handleGraphKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isNavigationKey(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
      const container = containerRef.current;
      const target = e.target as HTMLElement | null;
      const nodeEl = target?.closest<HTMLElement>('[data-topology-node="true"]');
      if (!container || !nodeEl || !container.contains(nodeEl)) return;
      const currentId = nodeEl.getAttribute('data-node-id');
      if (currentId === null) return;
      e.preventDefault(); // keep arrows from scrolling the page while a node has focus
      const points = nodes.map((n) => {
        const p = layoutPositions.get(n.id) ?? n.position ?? { x: 0, y: 0 };
        return { id: n.id, x: p.x, y: p.y };
      });
      const nextId = findNextNodeId(points, currentId, e.key);
      if (nextId === null) return;
      setActiveId(nextId);
      const nextEl = Array.from(
        container.querySelectorAll<HTMLElement>('[data-topology-node="true"]'),
      ).find((el) => el.getAttribute('data-node-id') === nextId);
      nextEl?.focus();
    },
    [nodes, layoutPositions],
  );

  if (isLoading) {
    return <LoadingState t={t} />;
  }

  if (error) {
    return <ErrorState t={t} error={error} />;
  }

  if (nodes.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 text-sm text-slate-500 dark:text-slate-400 font-medium">
        {emptyMessage ?? t.graph.emptyState}
      </div>
    );
  }

  const selectedNode: TopologyGraphNode | undefined =
    selectedNodeId !== null ? nodeById.get(selectedNodeId) : undefined;
  const summaryText = buildLiveSummary(t, nodes, edges, selectedNode);
  const issuesNotice = hasGraphDataIssues(sanitized)
    ? interpolate(t.graph.dataIssuesNotice, {
        duplicates: String(sanitized.duplicateNodeIds.length + sanitized.duplicateEdgeIds.length),
        dangling: String(sanitized.danglingEdgeCount),
      })
    : null;

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Accessible toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
          <button
            type="button"
            onClick={() => setViewMode('graph')}
            aria-pressed={viewMode === 'graph'}
            className={`${MIN_TARGET_CLASS} px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              viewMode === 'graph'
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Layout className="h-3.5 w-3.5" />
            {t.graph.graphView}
          </button>
          <button
            type="button"
            onClick={() => setViewMode('table')}
            aria-pressed={viewMode === 'table'}
            className={`${MIN_TARGET_CLASS} px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              viewMode === 'table'
                ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <TableIcon className="h-3.5 w-3.5" />
            {t.graph.tableView}
          </button>
        </div>

        <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 font-medium">
          <span className="flex items-center gap-1">
            <Keyboard className="h-3.5 w-3.5" />
            {t.graph.keyboardHint}
          </span>
        </div>
      </div>

      {/* Screen reader summary announcement */}
      <div className="sr-only" role="status" aria-live="polite">
        {summaryText}
      </div>

      {issuesNotice && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 dark:border-amber-500/50 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-900 dark:text-amber-200"
        >
          {issuesNotice}
        </p>
      )}

      {viewMode === 'graph' ? (
        <div
          ref={containerRef}
          onKeyDown={handleGraphKeyDown}
          className="relative rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-slate-50 dark:bg-slate-950"
          style={{ height }}
          role="region"
          aria-label={ariaLabel ?? t.graph.textAlternative}
        >
          <ReactFlow<TopologyFlowNodeType>
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => onSelectNode?.(n.id)}
            onPaneClick={() => onSelectNode?.(null)}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            disableKeyboardA11y
            zoomOnDoubleClick={false}
            colorMode={theme}
            proOptions={{ hideAttribution: true }}
            fitView
            fitViewOptions={{ padding: 0.3 }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div>
            <h5 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
              {t.graph.nodesTitle} ({nodes.length})
            </h5>
            <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
              <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.nodeLabel}</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.typeLabel}</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.statusLabel}</th>
                    <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.viewDetails}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
                  {nodes.map((node) => {
                    const isSelected = selectedNodeId === node.id;
                    return (
                      <tr
                        key={node.id}
                        className={`hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors ${
                          isSelected ? 'bg-cyan-50/50 dark:bg-cyan-950/40 font-bold' : ''
                        }`}
                      >
                        <td className="px-3 py-2 font-mono font-medium text-slate-900 dark:text-white">
                          <button
                            type="button"
                            onClick={() => onSelectNode?.(node.id)}
                            className={`${MIN_TARGET_CLASS} inline-flex items-center text-left hover:underline text-cyan-700 dark:text-cyan-400 font-bold`}
                          >
                            {nodeDisplayName(node)}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300 font-mono">
                          {node.badge ?? '-'}
                        </td>
                        <td className="px-3 py-2">
                          {node.status ? <StatusBadge status={node.status} t={t} /> : '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                          {node.detail ?? '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {edges.length > 0 && (
            <div>
              <h5 className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider mb-2">
                {t.graph.edgesTitle} ({edges.length})
              </h5>
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  <thead className="bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-400">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.sourceLabel}</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.targetLabel}</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.relationLabel}</th>
                      <th scope="col" className="px-3 py-2 text-left font-semibold">{t.graph.confidenceLabel}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800 bg-white dark:bg-slate-900">
                    {edges.map((edge) => (
                      <tr key={edge.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                        <td className="px-3 py-2 font-mono text-slate-900 dark:text-white">
                          {nodeById.has(edge.source) ? nodeDisplayName(nodeById.get(edge.source)!) : edge.source}
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-900 dark:text-white">
                          {nodeById.has(edge.target) ? nodeDisplayName(nodeById.get(edge.target)!) : edge.target}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-300">{edge.label ?? '-'}</td>
                        <td className="px-3 py-2 font-mono text-slate-600 dark:text-slate-300">
                          {edge.confidence !== undefined ? `${Math.round(edge.confidence * 100)}%` : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

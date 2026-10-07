import React from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { Translations } from '../../i18n/translations';
import { StatusBadge } from '../StatusBadge';
import { FOCUS_RING_CLASS, SELECTION_CLASS } from './theme';
import type { TopologyGraphNode } from './types';

export interface TopologyFlowNodeData extends Record<string, unknown> {
  node: TopologyGraphNode;
  t: Translations;
  isSelected: boolean;
  /** Roving tabindex: exactly one node of a graph is the Tab stop (tabIndex 0), the rest are -1. */
  isTabStop: boolean;
  /** false when no onSelectNode is wired: node is read-only (no button/pressed semantics). */
  interactive: boolean;
  onSelect?: (nodeId: string) => void;
  onFocusNode?: (nodeId: string) => void;
}

export type TopologyFlowNodeType = Node<TopologyFlowNodeData, 'topology'>;

/**
 * The xyflow wrapper around this component is made non-focusable by TopologyGraph
 * (nodesFocusable=false), so this element is the node's only focusable. Arrow-key movement is
 * handled once per graph container (see TopologyGraph), not here.
 */
export function TopologyFlowNode({ data }: NodeProps<TopologyFlowNodeType>) {
  const { node, t, isSelected, isTabStop, interactive, onSelect, onFocusNode } = data;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (interactive && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onSelect?.(node.id);
    }
  };

  const accessibleName =
    node.ariaLabel ??
    `${node.title}: ${node.subtitle}${node.status ? `, ${t.common.status}: ${t.status[node.status]}` : ''}`;

  return (
    <div
      role={interactive ? 'button' : 'group'}
      tabIndex={isTabStop ? 0 : -1}
      data-topology-node="true"
      data-node-id={node.id}
      aria-pressed={interactive ? isSelected : undefined}
      data-selected={isSelected ? 'true' : undefined}
      aria-label={accessibleName}
      onClick={interactive ? () => onSelect?.(node.id) : undefined}
      onKeyDown={handleKeyDown}
      onFocus={() => onFocusNode?.(node.id)}
      className={`w-[220px] rounded-xl border bg-white dark:bg-slate-900 p-3.5 shadow-xs transition-all motion-reduce:transition-none ${interactive ? 'cursor-pointer' : 'cursor-default'} text-left ${FOCUS_RING_CLASS} ${
        isSelected
          ? SELECTION_CLASS
          : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
      }`}
    >
      <Handle type="target" position={Position.Left} aria-hidden="true" className="!bg-slate-400 dark:!bg-slate-500" />
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-900 dark:text-white font-mono truncate">
          {node.title}
        </span>
        {node.badge && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 font-semibold border border-slate-200 dark:border-slate-700">
            {node.badge}
          </span>
        )}
      </div>
      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 font-medium mb-2.5 truncate" title={node.subtitle}>
        {node.subtitle}
      </div>
      {node.status && <StatusBadge status={node.status} t={t} />}
      <Handle type="source" position={Position.Right} aria-hidden="true" className="!bg-slate-400 dark:!bg-slate-500" />
    </div>
  );
}

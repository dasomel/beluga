import type { Translations } from '../../i18n/translations';
import { interpolate } from '../../i18n/interpolate';
import type { TopologyGraphEdge, TopologyGraphNode } from './types';

/**
 * Graph colour tokens with their literal hex so contrast is checked by tests (WCAG 1.4.11,
 * non-text >= 3:1). `*Class` strings are the Tailwind utilities that render the same colour;
 * the test asserts both stay paired. D3: light edge = slate-500 (not slate-400, 2.45:1),
 * light selection/focus = cyan-700 (not cyan-500, 2.43:1).
 */
export const GRAPH_TOKENS = {
  light: {
    canvas: '#f8fafc', // slate-50 (canvas bg-slate-50)
    card: '#ffffff', // card bg-white
    edge: '#64748b', // slate-500
    selection: '#0e7490', // cyan-700
  },
  dark: {
    canvas: '#020617', // slate-950
    card: '#0f172a', // slate-900
    edge: '#94a3b8', // slate-400
    selection: '#22d3ee', // cyan-400
  },
} as const;

export const SELECTION_CLASS = 'border-2 border-cyan-700 dark:border-cyan-400 bg-cyan-50/40 dark:bg-cyan-950/30';
export const FOCUS_RING_CLASS =
  'focus:outline-hidden focus-visible:ring-2 focus-visible:ring-cyan-700 dark:focus-visible:ring-cyan-400 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900';
/** WCAG 2.5.8: controls we size ourselves are at least 24x24 CSS px. */
export const MIN_TARGET_CLASS = 'min-h-6 min-w-6';

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`invalid hex colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Dashed edges animate only when the user has not asked for reduced motion. */
export function shouldAnimateEdge(dashed: boolean | undefined, prefersReducedMotion: boolean): boolean {
  return Boolean(dashed) && !prefersReducedMotion;
}

export function nodeDisplayName(node: Pick<TopologyGraphNode, 'title' | 'subtitle'>): string {
  return `${node.title}: ${node.subtitle}`;
}

export function edgeAriaLabel(
  t: Translations,
  edge: TopologyGraphEdge,
  byId: ReadonlyMap<string, TopologyGraphNode>,
): string {
  const s = byId.get(edge.source);
  const d = byId.get(edge.target);
  const base = interpolate(t.graph.edgeLabel, {
    source: s ? nodeDisplayName(s) : edge.source,
    target: d ? nodeDisplayName(d) : edge.target,
  });
  return edge.label ? `${base}, ${edge.label}` : base;
}

/** Text of the polite live region: reflects the current graph and selection, not a mount-time string. */
export function buildLiveSummary(
  t: Translations,
  nodes: readonly TopologyGraphNode[],
  edges: readonly TopologyGraphEdge[],
  selected: TopologyGraphNode | undefined,
): string {
  const summary = interpolate(t.graph.summary, { nodes: String(nodes.length), edges: String(edges.length) });
  if (!selected) return summary;
  const status = selected.status ? `, ${t.common.status}: ${t.status[selected.status]}` : '';
  return `${summary}. ${t.graph.selectedNode}: ${nodeDisplayName(selected)}${status}`;
}

import type { TopologyGraphEdge, TopologyGraphNode } from './types';

export interface SanitizedGraph {
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
  /** Node ids that appeared more than once (each listed once). */
  duplicateNodeIds: string[];
  /** Edge ids that appeared more than once (each listed once). */
  duplicateEdgeIds: string[];
  /** Edges dropped because source or target is not a node of this graph. */
  danglingEdgeCount: number;
}

/**
 * D1: Defined rule for malformed input -- the FIRST occurrence of an id wins,
 * later duplicates are dropped (never merged or overwritten), and edges that
 * reference a missing node are dropped. Nothing is dropped silently: callers
 * surface the returned counts to the user (TopologyGraph renders a notice).
 * Order of the surviving items is the input order, so the result is deterministic.
 */
export function sanitizeGraph(
  nodes: readonly TopologyGraphNode[],
  edges: readonly TopologyGraphEdge[],
): SanitizedGraph {
  const seenNodes = new Set<string>();
  const dupNodes = new Set<string>();
  const keptNodes: TopologyGraphNode[] = [];
  for (const node of nodes) {
    if (seenNodes.has(node.id)) {
      dupNodes.add(node.id);
      continue;
    }
    seenNodes.add(node.id);
    keptNodes.push(node);
  }

  const seenEdges = new Set<string>();
  const dupEdges = new Set<string>();
  const keptEdges: TopologyGraphEdge[] = [];
  let dangling = 0;
  for (const edge of edges) {
    if (seenEdges.has(edge.id)) {
      dupEdges.add(edge.id);
      continue;
    }
    seenEdges.add(edge.id);
    if (!seenNodes.has(edge.source) || !seenNodes.has(edge.target)) {
      dangling += 1;
      continue;
    }
    keptEdges.push(edge);
  }

  return {
    nodes: keptNodes,
    edges: keptEdges,
    duplicateNodeIds: [...dupNodes],
    duplicateEdgeIds: [...dupEdges],
    danglingEdgeCount: dangling,
  };
}

export function hasGraphDataIssues(g: SanitizedGraph): boolean {
  return g.duplicateNodeIds.length > 0 || g.duplicateEdgeIds.length > 0 || g.danglingEdgeCount > 0;
}

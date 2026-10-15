import type { TopologyGraphEdge, TopologyGraphNode } from './types';

export const GRAPH_NODE_WIDTH = 220;
export const GRAPH_NODE_HEIGHT = 100;
export const GRAPH_GAP_X = 90;
export const GRAPH_GAP_Y = 24;

/**
 * Deterministic left-to-right layered layout.
 *
 * - Explicit `position`s are always respected (all-positioned graphs are returned as-is).
 * - Duplicate node ids: first occurrence wins (same rule as sanitizeGraph, D1).
 * - Edges to missing nodes and self-links are ignored for layering.
 * - Cycles (D2): a DFS in input order (roots = nodes without incoming edges first, then the
 *   remaining nodes in input order) classifies back-edges; those are dropped for layering only
 *   (they are still drawn by the renderer). The remaining graph is a DAG that is layered by
 *   longest path, so a cycle a->b->c->a yields columns a,b,c and descendants of the cycle keep
 *   their own columns instead of collapsing into column 0. This is a cheap feedback-arc
 *   heuristic, not a minimum feedback arc set; it is O(V+E) and iterative (no recursion limit).
 * - Rows inside a layer keep input order.
 */
export function computeGraphLayout(
  nodes: readonly TopologyGraphNode[],
  edges: readonly TopologyGraphEdge[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const unique: TopologyGraphNode[] = [];
  const index = new Map<string, number>();
  for (const n of nodes) {
    if (index.has(n.id)) continue;
    index.set(n.id, unique.length);
    unique.push(n);
  }

  if (unique.every((n) => n.position !== undefined)) {
    for (const n of unique) positions.set(n.id, n.position!);
    return positions;
  }

  const count = unique.length;
  const out: number[][] = Array.from({ length: count }, () => []);
  const indeg = new Array<number>(count).fill(0);
  for (const e of edges) {
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined || s === t) continue;
    out[s]!.push(t);
    indeg[t] = (indeg[t] ?? 0) + 1;
  }

  // Iterative DFS: 0 = unvisited, 1 = on stack, 2 = done.
  const state = new Array<number>(count).fill(0);
  const dag: number[][] = Array.from({ length: count }, () => []);
  const dagIndeg = new Array<number>(count).fill(0);
  const roots: number[] = [];
  for (let i = 0; i < count; i++) if (indeg[i] === 0) roots.push(i);
  for (let i = 0; i < count; i++) if (indeg[i] !== 0) roots.push(i);

  for (const root of roots) {
    if (state[root] !== 0) continue;
    const stack: Array<{ node: number; next: number }> = [{ node: root, next: 0 }];
    state[root] = 1;
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const targets = out[frame.node]!;
      if (frame.next >= targets.length) {
        state[frame.node] = 2;
        stack.pop();
        continue;
      }
      const to = targets[frame.next++]!;
      if (state[to] === 1) continue; // back-edge: ignored for layering
      dag[frame.node]!.push(to);
      dagIndeg[to] = (dagIndeg[to] ?? 0) + 1;
      if (state[to] === 0) {
        state[to] = 1;
        stack.push({ node: to, next: 0 });
      }
    }
  }

  // Longest-path layering over the DAG (Kahn, array queue with head pointer).
  const layer = new Array<number>(count).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < count; i++) if (dagIndeg[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    for (const next of dag[cur]!) {
      layer[next] = Math.max(layer[next]!, layer[cur]! + 1);
      dagIndeg[next] = dagIndeg[next]! - 1;
      if (dagIndeg[next] === 0) queue.push(next);
    }
  }

  const rowInLayer = new Map<number, number>();
  unique.forEach((node, i) => {
    if (node.position) {
      positions.set(node.id, node.position);
      return;
    }
    const l = layer[i]!;
    const row = rowInLayer.get(l) ?? 0;
    rowInLayer.set(l, row + 1);
    positions.set(node.id, {
      x: l * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
      y: row * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
    });
  });

  return positions;
}

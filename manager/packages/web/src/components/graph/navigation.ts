import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from './layout';

export type NavigationKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export interface NavigablePoint {
  id: string;
  x: number;
  y: number;
}

const DIRECTIONS: Record<'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight', { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

/** Perpendicular drift is penalised so "right" prefers the node that is actually in the same row. */
const PERPENDICULAR_WEIGHT = 2;

export function isNavigationKey(key: string): key is NavigationKey {
  return Object.hasOwn(DIRECTIONS, key) || key === 'Home' || key === 'End';
}

/**
 * Pure spatial navigation: positions + current id + key => next id (or null = stay).
 * Arrow keys pick the nearest node whose centre lies strictly in the pressed direction
 * (score = distance along the axis + 2 x perpendicular offset; ties broken by input order, so the
 * result is deterministic). Home/End jump to the first/last node in reading order (top-left origin,
 * row-major by y then x). `points` are top-left node positions of ONE graph, so scoping to a
 * graph is by construction: another graph's nodes can never be returned.
 */
export function findNextNodeId(
  points: readonly NavigablePoint[],
  currentId: string,
  key: NavigationKey,
): string | null {
  // Non-finite coordinates (NaN/Infinity) would poison scores and sort order: ignore such nodes.
  points = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (points.length === 0) return null;
  const current = points.find((p) => p.id === currentId);

  if (key === 'Home' || key === 'End') {
    const sorted = [...points].sort((a, b) => a.y - b.y || a.x - b.x);
    return (key === 'Home' ? sorted[0] : sorted[sorted.length - 1])!.id;
  }
  if (!current) return null;

  const dir = DIRECTIONS[key];
  const cx = current.x + GRAPH_NODE_WIDTH / 2;
  const cy = current.y + GRAPH_NODE_HEIGHT / 2;
  let best: { id: string; score: number } | null = null;
  for (const p of points) {
    if (p.id === current.id) continue;
    const dx = p.x + GRAPH_NODE_WIDTH / 2 - cx;
    const dy = p.y + GRAPH_NODE_HEIGHT / 2 - cy;
    const along = dx * dir.x + dy * dir.y;
    if (along <= 0) continue;
    const across = Math.abs(dx * dir.y + dy * dir.x);
    const score = along + PERPENDICULAR_WEIGHT * across;
    if (best === null || score < best.score) best = { id: p.id, score };
  }
  return best?.id ?? null;
}

/** Roving tabindex: the single Tab stop of the graph. Falls back selected -> first node. */
export function resolveActiveNodeId(
  ids: readonly string[],
  active: string | null,
  selected: string | null,
): string | null {
  if (active !== null && ids.includes(active)) return active;
  if (selected !== null && ids.includes(selected)) return selected;
  return ids[0] ?? null;
}

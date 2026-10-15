import { describe, expect, it } from 'vitest';
import { GRAPH_GAP_X, GRAPH_GAP_Y, GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from './layout';
import { findNextNodeId, isNavigationKey, resolveActiveNodeId, type NavigablePoint } from './navigation';

const COL = GRAPH_NODE_WIDTH + GRAPH_GAP_X;
const ROW = GRAPH_NODE_HEIGHT + GRAPH_GAP_Y;
const pt = (id: string, col: number, row: number): NavigablePoint => ({ id, x: col * COL, y: row * ROW });

// DOM order deliberately differs from spatial order (b before a) to prove DOM order is not used.
//   col0   col1   col2
//   a(0,0) b(1,0) c(2,0)
//   d(0,1)        e(2,1)
const grid = [pt('b', 1, 0), pt('a', 0, 0), pt('c', 2, 0), pt('e', 2, 1), pt('d', 0, 1)];

describe('findNextNodeId', () => {
  it('moves to the nearest node in the pressed direction, independent of array order', () => {
    expect(findNextNodeId(grid, 'a', 'ArrowRight')).toBe('b');
    expect(findNextNodeId(grid, 'b', 'ArrowRight')).toBe('c');
    expect(findNextNodeId(grid, 'c', 'ArrowLeft')).toBe('b');
    expect(findNextNodeId(grid, 'a', 'ArrowDown')).toBe('d');
    expect(findNextNodeId(grid, 'd', 'ArrowUp')).toBe('a');
    expect(findNextNodeId(grid, 'c', 'ArrowDown')).toBe('e');
  });

  it('prefers the node in the same row over a nearer-but-off-axis one', () => {
    // from a: right has b (same row, 1 col) and e (row below, 2 cols) -> b; from c-left likewise
    expect(findNextNodeId(grid, 'a', 'ArrowRight')).toBe('b');
    // same column distance, different rows: the aligned node beats the diagonal one
    const diag = [pt('s', 0, 0), pt('diag', 1, 1), pt('flat', 1, 0)];
    expect(findNextNodeId(diag, 's', 'ArrowRight')).toBe('flat');
    // when nothing is aligned the nearest diagonal is still reachable (no dead ends)
    expect(findNextNodeId(grid, 'd', 'ArrowRight')).toBe('b');
  });

  it('returns null at the edge of the graph instead of wrapping or jumping', () => {
    expect(findNextNodeId(grid, 'a', 'ArrowLeft')).toBeNull();
    expect(findNextNodeId(grid, 'a', 'ArrowUp')).toBeNull();
    expect(findNextNodeId(grid, 'e', 'ArrowRight')).toBeNull();
  });

  it('returns null for a single node, an unknown current id and an empty graph', () => {
    expect(findNextNodeId([pt('a', 0, 0)], 'a', 'ArrowRight')).toBeNull();
    expect(findNextNodeId(grid, 'nope', 'ArrowRight')).toBeNull();
    expect(findNextNodeId([], 'a', 'ArrowRight')).toBeNull();
  });

  it('Home/End jump to first/last node in reading order', () => {
    expect(findNextNodeId(grid, 'c', 'Home')).toBe('a');
    expect(findNextNodeId(grid, 'a', 'End')).toBe('e');
  });

  it('is scoped to the supplied points: a second graph can never be reached', () => {
    const graph1 = [pt('g1-a', 0, 0), pt('g1-b', 1, 0)];
    const graph2 = [pt('g2-a', 2, 0), pt('g2-b', 3, 0)]; // spatially to the right of graph1
    expect(findNextNodeId(graph1, 'g1-b', 'ArrowRight')).toBeNull();
    expect(findNextNodeId(graph2, 'g2-a', 'ArrowLeft')).toBeNull();
  });

  it('breaks ties deterministically by input order', () => {
    const tie = [pt('c', 0, 0), pt('x', 1, -1), pt('y', 1, 1)]; // x and y equidistant to the right of c
    expect(findNextNodeId(tie, 'c', 'ArrowRight')).toBe('x');
    expect(findNextNodeId([...tie].reverse(), 'c', 'ArrowRight')).toBe('y');
  });

  it('handles co-located nodes without returning the current node', () => {
    const same = [pt('a', 0, 0), pt('b', 0, 0)];
    expect(findNextNodeId(same, 'a', 'ArrowRight')).toBeNull();
  });
});

describe('findNextNodeId with non-finite coordinates', () => {
  const bad = (id: string, x: number, y: number): NavigablePoint => ({ id, x, y });
  it('skips NaN/Infinity candidates instead of letting them win', () => {
    const pts = [bad('a', 0, 0), bad('n', NaN, 0), bad('b', 300, 0), bad('i', Infinity, 0)];
    expect(findNextNodeId(pts, 'a', 'ArrowRight')).toBe('b');
  });
  it('returns null when the current node itself is non-finite', () => {
    expect(findNextNodeId([bad('n', NaN, 0), bad('b', 300, 0)], 'n', 'ArrowRight')).toBeNull();
  });
  it('keeps Home/End stable by ignoring non-finite nodes', () => {
    const pts = [bad('n', NaN, NaN), bad('b', 300, 0), bad('a', 0, 0)];
    expect(findNextNodeId(pts, 'b', 'Home')).toBe('a');
    expect(findNextNodeId(pts, 'a', 'End')).toBe('b');
    expect(findNextNodeId([bad('n', NaN, 0)], 'n', 'Home')).toBeNull();
  });
});

describe('isNavigationKey', () => {
  it('accepts arrows plus Home/End and rejects the rest', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) expect(isNavigationKey(k)).toBe(true);
    for (const k of ['Tab', 'Enter', ' ', 'a', 'toString', 'constructor']) expect(isNavigationKey(k)).toBe(false);
  });
});

describe('resolveActiveNodeId (roving tabindex)', () => {
  const ids = ['a', 'b', 'c'];
  it('prefers the active id, then the selected id, then the first node', () => {
    expect(resolveActiveNodeId(ids, 'b', 'c')).toBe('b');
    expect(resolveActiveNodeId(ids, null, 'c')).toBe('c');
    expect(resolveActiveNodeId(ids, 'gone', 'also-gone')).toBe('a');
    expect(resolveActiveNodeId([], null, null)).toBeNull();
  });
});

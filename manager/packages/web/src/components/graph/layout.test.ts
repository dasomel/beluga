import { describe, expect, it } from 'vitest';
import { computeGraphLayout, GRAPH_NODE_WIDTH, GRAPH_GAP_X, GRAPH_NODE_HEIGHT, GRAPH_GAP_Y } from './layout';
import type { TopologyGraphEdge, TopologyGraphNode } from './types';

describe('computeGraphLayout', () => {
  it('returns empty map for empty node list', () => {
    const positions = computeGraphLayout([], []);
    expect(positions.size).toBe(0);
  });

  it('preserves existing explicit positions if all nodes are positioned', () => {
    const nodes: TopologyGraphNode[] = [
      { id: 'n1', title: 'N1', subtitle: 's1', position: { x: 10, y: 20 } },
      { id: 'n2', title: 'N2', subtitle: 's2', position: { x: 30, y: 40 } },
    ];
    const positions = computeGraphLayout(nodes, []);
    expect(positions.get('n1')).toEqual({ x: 10, y: 20 });
    expect(positions.get('n2')).toEqual({ x: 30, y: 40 });
  });

  it('computes linear DAG layering left-to-right', () => {
    const nodes: TopologyGraphNode[] = [
      { id: 'a', title: 'A', subtitle: 'a' },
      { id: 'b', title: 'B', subtitle: 'b' },
      { id: 'c', title: 'C', subtitle: 'c' },
    ];
    const edges: TopologyGraphEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' },
    ];
    const positions = computeGraphLayout(nodes, edges);
    const posA = positions.get('a')!;
    const posB = positions.get('b')!;
    const posC = positions.get('c')!;

    expect(posA.x).toBe(0);
    expect(posB.x).toBe(GRAPH_NODE_WIDTH + GRAPH_GAP_X);
    expect(posC.x).toBe((GRAPH_NODE_WIDTH + GRAPH_GAP_X) * 2);
  });

  it('handles diamond DAG structure (fan-out and fan-in)', () => {
    const nodes: TopologyGraphNode[] = [
      { id: 'root', title: 'Root', subtitle: 'r' },
      { id: 'left', title: 'Left', subtitle: 'l' },
      { id: 'right', title: 'Right', subtitle: 'r' },
      { id: 'sink', title: 'Sink', subtitle: 's' },
    ];
    const edges: TopologyGraphEdge[] = [
      { id: 'e1', source: 'root', target: 'left' },
      { id: 'e2', source: 'root', target: 'right' },
      { id: 'e3', source: 'left', target: 'sink' },
      { id: 'e4', source: 'right', target: 'sink' },
    ];
    const positions = computeGraphLayout(nodes, edges);
    expect(positions.get('root')!.x).toBe(0);
    expect(positions.get('left')!.x).toBe(GRAPH_NODE_WIDTH + GRAPH_GAP_X);
    expect(positions.get('right')!.x).toBe(GRAPH_NODE_WIDTH + GRAPH_GAP_X);
    expect(positions.get('sink')!.x).toBe((GRAPH_NODE_WIDTH + GRAPH_GAP_X) * 2);
    // Rows within the same layer should differ
    expect(positions.get('left')!.y).not.toBe(positions.get('right')!.y);
  });

  it('scales cleanly to 50 nodes without collisions or errors', () => {
    const nodes: TopologyGraphNode[] = Array.from({ length: 50 }, (_, i) => ({
      id: `node-${i}`,
      title: `Node ${i}`,
      subtitle: `sub-${i}`,
    }));
    // Chain groups of 5
    const edges: TopologyGraphEdge[] = [];
    for (let i = 0; i < 49; i++) {
      edges.push({ id: `e-${i}`, source: `node-${i}`, target: `node-${i + 1}` });
    }
    const positions = computeGraphLayout(nodes, edges);
    expect(positions.size).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(positions.get(`node-${i}`)).toBeDefined();
    }
  });

  describe('cycles, malformed input and determinism', () => {
    const COL = GRAPH_NODE_WIDTH + GRAPH_GAP_X;
    const n = (id: string, extra: Partial<TopologyGraphNode> = {}): TopologyGraphNode => ({ id, title: id, subtitle: id, ...extra });
    const e = (source: string, target: string): TopologyGraphEdge => ({ id: `${source}->${target}`, source, target });

    it('layers a pure cycle a->b->c->a as consecutive columns instead of collapsing into column 0', () => {
      const p = computeGraphLayout([n('a'), n('b'), n('c')], [e('a', 'b'), e('b', 'c'), e('c', 'a')]);
      expect([p.get('a')!.x, p.get('b')!.x, p.get('c')!.x]).toEqual([0, COL, COL * 2]);
    });

    it('keeps descendants of a cycle in their own later columns', () => {
      const p = computeGraphLayout(
        [n('src'), n('a'), n('b'), n('sink')],
        [e('src', 'a'), e('a', 'b'), e('b', 'a'), e('b', 'sink')],
      );
      expect(p.get('src')!.x).toBe(0);
      expect(p.get('a')!.x).toBe(COL);
      expect(p.get('b')!.x).toBe(COL * 2);
      expect(p.get('sink')!.x).toBe(COL * 3);
    });

    it('ignores self-links for layering', () => {
      const p = computeGraphLayout([n('a'), n('b')], [e('a', 'a'), e('a', 'b')]);
      expect(p.get('a')!.x).toBe(0);
      expect(p.get('b')!.x).toBe(COL);
    });

    it('places disconnected components in column 0, one row each, without overlap', () => {
      const p = computeGraphLayout([n('a'), n('b'), n('c'), n('d')], [e('a', 'b')]);
      const keys = new Set([...p.values()].map((v) => `${v.x},${v.y}`));
      expect(keys.size).toBe(4);
      expect(p.get('c')).toEqual({ x: 0, y: GRAPH_NODE_HEIGHT + GRAPH_GAP_Y });
    });

    it('first occurrence of a duplicate id wins and no extra position is produced', () => {
      const p = computeGraphLayout([n('a'), n('a', { title: 'dup' }), n('b')], [e('a', 'b')]);
      expect(p.size).toBe(2);
      expect(p.get('a')).toEqual({ x: 0, y: 0 });
      expect(p.get('b')!.x).toBe(COL);
    });

    it('ignores edges that reference missing nodes', () => {
      const p = computeGraphLayout([n('a'), n('b')], [e('a', 'ghost'), e('ghost', 'b')]);
      expect(p.get('a')!.x).toBe(0);
      expect(p.get('b')!.x).toBe(0);
    });

    it('respects explicit positions for some nodes while layering the rest', () => {
      const p = computeGraphLayout([n('a', { position: { x: 5, y: 6 } }), n('b')], [e('a', 'b')]);
      expect(p.get('a')).toEqual({ x: 5, y: 6 });
      expect(p.get('b')!.x).toBe(COL);
    });

    it('is deterministic for identical input', () => {
      const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => n(id));
      const edges = [e('a', 'b'), e('b', 'c'), e('c', 'a'), e('c', 'd'), e('e', 'd')];
      expect([...computeGraphLayout(nodes, edges)]).toEqual([...computeGraphLayout(nodes, edges)]);
    });

    it('handles 5000-node chains and cycles without recursion overflow', () => {
      const nodes = Array.from({ length: 5000 }, (_, i) => n(`n${i}`));
      const edges = nodes.map((_, i) => e(`n${i}`, `n${(i + 1) % 5000}`)); // one giant cycle
      const p = computeGraphLayout(nodes, edges);
      expect(p.size).toBe(5000);
      expect(p.get('n4999')!.x).toBe(COL * 4999);
    });
  });
});

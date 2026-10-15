import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getTranslations } from '../../i18n/getTranslations';
import { TopologyGraph } from './TopologyGraph';
import { GRAPH_TOKENS } from './theme';
import type { TopologyGraphEdge, TopologyGraphNode } from './types';

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testNodes: TopologyGraphNode[] = [
  {
    id: 'kafka-topic:orders',
    title: 'Kafka topic',
    subtitle: 'orders',
    badge: 'kafka-topic',
    status: 'healthy',
  },
  {
    id: 'flink-job:orders-sync',
    title: 'Flink job',
    subtitle: 'orders-sync',
    badge: 'flink-job',
    status: 'degraded',
  },
];

const testEdges: TopologyGraphEdge[] = [
  {
    id: 'e1',
    source: 'kafka-topic:orders',
    target: 'flink-job:orders-sync',
    label: 'Topic feeds job',
    confidence: 0.95,
  },
];

describe('TopologyGraph', () => {
  it('renders loading state when isLoading is true', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={[]} edges={[]} isLoading={true} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when error is provided', () => {
    const html = renderToStaticMarkup(
      <TopologyGraph t={tEn} nodes={[]} edges={[]} error={new Error('Graph load error')} />,
    );
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Graph load error');
  });

  it('renders empty state when nodes are empty', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={[]} edges={[]} />);
    expect(html).toContain(tEn.graph.emptyState);
  });

  it('renders custom empty message when provided', () => {
    const html = renderToStaticMarkup(
      <TopologyGraph t={tEn} nodes={[]} edges={[]} emptyMessage="Custom empty pipeline" />,
    );
    expect(html).toContain('Custom empty pipeline');
  });

  it('renders nodes with title, subtitle, badge, and status', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} />);
    expect(html).toContain('Kafka topic');
    expect(html).toContain('orders');
    expect(html).toContain('Flink job');
    expect(html).toContain('orders-sync');
    // Status text is rendered alongside badge colour (WCAG AA non-color signal)
    expect(html).toContain(tEn.status.healthy);
    expect(html).toContain(tEn.status.degraded);
  });

  it('includes keyboard navigation attributes and focus visible styles on nodes', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} onSelectNode={() => {}} />);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    expect(html).toContain('data-topology-node="true"');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain(tEn.graph.keyboardHint);
  });

  it('renders screen reader summary text alternative', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} />);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('2'); // nodes count
    expect(html).toContain('1'); // edges count
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tKo} nodes={testNodes} edges={testEdges} />);
    expect(html).toContain(tKo.graph.graphView);
    expect(html).toContain(tKo.graph.tableView);
    expect(html).toContain(tKo.graph.keyboardHint);
  });

  it('renders 50 nodes without throwing or crashing', () => {
    const fiftyNodes: TopologyGraphNode[] = Array.from({ length: 50 }, (_, i) => ({
      id: `node-${i}`,
      title: `Node ${i}`,
      subtitle: `sub-${i}`,
    }));
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={fiftyNodes} edges={[]} />);
    expect(html).toContain('Node 0');
    expect(html).toContain('Node 49');
  });

  describe('theme', () => {
    it('renders the xyflow canvas in the requested colour mode and themed arrow colour', () => {
      const light = renderToStaticMarkup(<TopologyGraph t={tEn} theme="light" nodes={testNodes} edges={testEdges} />);
      const dark = renderToStaticMarkup(<TopologyGraph t={tEn} theme="dark" nodes={testNodes} edges={testEdges} />);
      expect(light).toContain('class="react-flow light"');
      expect(dark).toContain('class="react-flow dark"');
      expect(light).toContain(`stroke:${GRAPH_TOKENS.light.edge}`);
      expect(dark).toContain(`stroke:${GRAPH_TOKENS.dark.edge}`);
      expect(light).not.toContain('#94a3b8'); // the 2.45:1 colour must not come back in light mode
    });

    it('uses the >=3:1 selection/focus classes on nodes in both themes', () => {
      const html = renderToStaticMarkup(
        <TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} selectedNodeId={testNodes[0]!.id} />,
      );
      expect(html).toContain('border-cyan-700');
      expect(html).toContain('dark:border-cyan-400');
      expect(html).toContain('focus-visible:ring-cyan-700');
      expect(html).not.toContain('cyan-500');
    });
  });

  describe('keyboard and focus structure', () => {
    const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} onSelectNode={() => {}} />);

    it('has exactly one Tab stop for the whole graph (roving tabindex)', () => {
      const inGraph = html.slice(html.indexOf('react-flow__nodes'), html.indexOf('react-flow__controls') - 60);
      expect(inGraph.match(/tabindex="0"/g)).toHaveLength(1);
      expect(inGraph.match(/tabindex="-1"/g)).toHaveLength(testNodes.length - 1);
    });

    it('makes the first node the Tab stop by default and the selected node when there is a selection', () => {
      const sel = renderToStaticMarkup(
        <TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} selectedNodeId={testNodes[1]!.id} onSelectNode={() => {}} />,
      );
      expect(html).toMatch(/tabindex="0"[^>]*aria-pressed="false"[^>]*aria-label="Kafka topic: orders/);
      expect(sel).toMatch(/tabindex="-1"[^>]*aria-pressed="false"[^>]*aria-label="Kafka topic: orders/);
      expect(sel).toMatch(/tabindex="0"[^>]*aria-pressed="true"[^>]*aria-label="Flink job: orders-sync/);
    });

    it('read-only graphs (no onSelectNode) keep focus and names but drop button/pressed semantics', () => {
      const ro = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} />);
      expect(ro).not.toContain('role="button"');
      expect(ro).not.toContain('aria-pressed="false" aria-label="Kafka');
      expect(ro).toMatch(/role="group"[^>]*tabindex="0"[^>]*aria-label="Kafka topic: orders/);
    });

    it('neutralises the xyflow node wrapper (no tabindex, no group role, no roledescription, no raw-id descriptions)', () => {
      const wrappers = html.match(/<div class="react-flow__node [^>]*>/g) ?? [];
      expect(wrappers).toHaveLength(testNodes.length);
      for (const w of wrappers) {
        expect(w).toContain('role="presentation"');
        expect(w).not.toContain('tabindex');
        expect(w).not.toContain('aria-roledescription');
        expect(w).not.toContain('aria-describedby');
      }
      expect(html).not.toContain('role="group"');
    });

    it('exposes a descriptive name on every node and no raw ids as names', () => {
      expect(html).toContain('aria-label="Kafka topic: orders, Status: Healthy"');
      expect(html).not.toContain('aria-label="kafka-topic:orders');
    });
  });

  describe('live summary and data issues', () => {
    it('announces the current selection, not a fixed mount-time string', () => {
      const none = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} />);
      const sel = renderToStaticMarkup(
        <TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} selectedNodeId={testNodes[1]!.id} />,
      );
      expect(none).not.toContain(tEn.graph.selectedNode);
      expect(sel).toMatch(/role="status" aria-live="polite">[^<]*Flink job: orders-sync/);
    });

    it('shows a visible notice for duplicate ids and dangling edges and renders each duplicate once', () => {
      const html = renderToStaticMarkup(
        <TopologyGraph
          t={tEn}
          nodes={[...testNodes, { ...testNodes[0]!, subtitle: 'DUPLICATE-BODY' }]}
          edges={[...testEdges, { id: 'bad', source: 'kafka-topic:orders', target: 'ghost' }]}
        />,
      );
      expect(html).toContain('Graph data issues: 1 duplicate id(s)');
      expect(html).toContain('1 connection(s) to missing nodes');
      expect(html).not.toContain('DUPLICATE-BODY');
      expect(html).not.toContain('Graph data issues: 0');
    });

    it('shows no notice for clean data', () => {
      const html = renderToStaticMarkup(<TopologyGraph t={tEn} nodes={testNodes} edges={testEdges} />);
      expect(html).not.toContain('Graph data issues');
    });
  });
});

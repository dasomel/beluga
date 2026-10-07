import { describe, expect, it } from 'vitest';
import { getTranslations } from '../../i18n/getTranslations';
import {
  FOCUS_RING_CLASS,
  GRAPH_TOKENS,
  MIN_TARGET_CLASS,
  SELECTION_CLASS,
  buildLiveSummary,
  contrastRatio,
  edgeAriaLabel,
  shouldAnimateEdge,
} from './theme';

describe('contrastRatio', () => {
  it('matches known WCAG values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  it('documents the regressions the review found (old colours fail 3:1)', () => {
    expect(contrastRatio('#94a3b8', '#f8fafc')).toBeLessThan(3); // old light edge, ~2.45
    expect(contrastRatio('#06b6d4', '#ffffff')).toBeLessThan(3); // old light cyan-500 ring, ~2.43
  });
});

describe('graph colour tokens (WCAG 1.4.11 non-text contrast >= 3:1)', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`${theme}: edge/arrow colour vs canvas`, () => {
      expect(contrastRatio(GRAPH_TOKENS[theme].edge, GRAPH_TOKENS[theme].canvas)).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: selection border and focus ring vs card`, () => {
      expect(contrastRatio(GRAPH_TOKENS[theme].selection, GRAPH_TOKENS[theme].card)).toBeGreaterThanOrEqual(3);
    });
    it(`${theme}: selection and focus ring also clear the canvas behind the card`, () => {
      expect(contrastRatio(GRAPH_TOKENS[theme].selection, GRAPH_TOKENS[theme].canvas)).toBeGreaterThanOrEqual(3);
    });
  }

  it('keeps the Tailwind classes paired with the hex tokens that are tested', () => {
    expect(SELECTION_CLASS).toContain('border-cyan-700'); // #0e7490
    expect(SELECTION_CLASS).toContain('dark:border-cyan-400'); // #22d3ee
    expect(FOCUS_RING_CLASS).toContain('focus-visible:ring-cyan-700');
    expect(FOCUS_RING_CLASS).toContain('dark:focus-visible:ring-cyan-400');
    expect(GRAPH_TOKENS.light.selection).toBe('#0e7490');
    expect(GRAPH_TOKENS.dark.selection).toBe('#22d3ee');
    expect(SELECTION_CLASS).not.toMatch(/cyan-500/);
  });

  it('declares a 24px minimum target (WCAG 2.5.8)', () => {
    expect(MIN_TARGET_CLASS).toBe('min-h-6 min-w-6'); // Tailwind spacing 6 = 1.5rem = 24px
  });
});

describe('shouldAnimateEdge', () => {
  it('animates only dashed edges and never under prefers-reduced-motion', () => {
    expect(shouldAnimateEdge(true, false)).toBe(true);
    expect(shouldAnimateEdge(true, true)).toBe(false);
    expect(shouldAnimateEdge(false, false)).toBe(false);
    expect(shouldAnimateEdge(undefined, false)).toBe(false);
  });
});

describe('accessible names and live summary', () => {
  const t = getTranslations('en-US');
  const a = { id: 'kafka-topic:orders', title: 'Kafka topic', subtitle: 'orders', status: 'degraded' as const };
  const b = { id: 'flink-job:x', title: 'Flink job', subtitle: 'x' };
  const byId = new Map([a, b].map((n) => [n.id, n] as const));

  it('edge names use node titles, not raw ids', () => {
    const label = edgeAriaLabel(t, { id: 'e', source: a.id, target: b.id, label: 'feeds' }, byId);
    expect(label).toContain('Kafka topic: orders');
    expect(label).toContain('Flink job: x');
    expect(label).toContain('feeds');
    expect(label).not.toContain('kafka-topic:orders');
  });

  it('live summary reflects selection state', () => {
    const none = buildLiveSummary(t, [a, b], [], undefined);
    const sel = buildLiveSummary(t, [a, b], [], a);
    expect(none).toContain('2 nodes');
    expect(none).not.toContain(t.graph.selectedNode);
    expect(sel).toContain(`${t.graph.selectedNode}: Kafka topic: orders`);
    expect(sel).toContain(t.status.degraded);
    expect(sel).not.toBe(none);
  });
});

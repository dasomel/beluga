import { describe, expect, it } from 'vitest';
import { hasGraphDataIssues, sanitizeGraph } from './sanitize';

const n = (id: string, title = id) => ({ id, title, subtitle: id });
const e = (id: string, source: string, target: string) => ({ id, source, target });

describe('sanitizeGraph', () => {
  it('passes clean input through unchanged', () => {
    const g = sanitizeGraph([n('a'), n('b')], [e('1', 'a', 'b')]);
    expect(g.nodes.map((x) => x.id)).toEqual(['a', 'b']);
    expect(g.edges).toHaveLength(1);
    expect(hasGraphDataIssues(g)).toBe(false);
  });

  it('keeps the first duplicate node id and reports it', () => {
    const g = sanitizeGraph([n('a', 'first'), n('a', 'second'), n('a', 'third')], []);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]!.title).toBe('first');
    expect(g.duplicateNodeIds).toEqual(['a']);
    expect(hasGraphDataIssues(g)).toBe(true);
  });

  it('keeps the first duplicate edge id and reports it', () => {
    const g = sanitizeGraph([n('a'), n('b')], [e('x', 'a', 'b'), e('x', 'b', 'a')]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.source).toBe('a');
    expect(g.duplicateEdgeIds).toEqual(['x']);
  });

  it('drops and counts edges to missing nodes', () => {
    const g = sanitizeGraph([n('a')], [e('1', 'a', 'ghost'), e('2', 'ghost', 'a')]);
    expect(g.edges).toHaveLength(0);
    expect(g.danglingEdgeCount).toBe(2);
    expect(hasGraphDataIssues(g)).toBe(true);
  });

  it('keeps self-links and cycles (they are valid data)', () => {
    const g = sanitizeGraph([n('a'), n('b')], [e('1', 'a', 'a'), e('2', 'a', 'b'), e('3', 'b', 'a')]);
    expect(g.edges).toHaveLength(3);
    expect(hasGraphDataIssues(g)).toBe(false);
  });
});

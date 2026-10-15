import { describe, expect, it } from 'vitest';
import { isExpandableKind, toggleExpanded } from './catalogTree';

describe('catalogTree', () => {
  it('only catalog and schema nodes are expandable', () => {
    expect(isExpandableKind('catalog')).toBe(true);
    expect(isExpandableKind('schema')).toBe(true);
    expect(isExpandableKind('table')).toBe(false);
    expect(isExpandableKind('topic')).toBe(false);
  });

  it('toggleExpanded adds, removes, and does not mutate its input', () => {
    const empty = new Set<string>();
    const open = toggleExpanded(empty, 'a');
    expect([...open]).toEqual(['a']);
    expect(empty.size).toBe(0);
    expect([...toggleExpanded(open, 'a')]).toEqual([]);
    expect([...toggleExpanded(open, 'b')]).toEqual(['a', 'b']);
  });
});

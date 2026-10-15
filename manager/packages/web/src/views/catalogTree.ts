import type { DataAssetKind } from '@beluga-manager/domain-api/schema';

// Only catalog/schema nodes have children in the hierarchy (ADR-0004); tables are leaves and
// topics sit outside the catalog tree.
export function isExpandableKind(kind: DataAssetKind): boolean {
  return kind === 'catalog' || kind === 'schema';
}

export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

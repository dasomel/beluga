export function paginate<T>(items: readonly T[], page: number, pageSize: number): { pageItems: T[]; total: number } {
  const total = items.length;
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return { pageItems, total };
}

export const containerHealthFilters = ['all', 'attention', 'running', 'stopped'] as const;
export type ContainerHealthFilter = (typeof containerHealthFilters)[number];

export function containerHealthFilter(value: string | null): ContainerHealthFilter {
  return containerHealthFilters.find((filter) => filter === value) ?? 'all';
}

export function withContainerHealthFilter(query: URLSearchParams, filter: ContainerHealthFilter): URLSearchParams {
  const next = new URLSearchParams(query);
  if (filter === 'all') next.delete('health');
  else next.set('health', filter);
  return next;
}

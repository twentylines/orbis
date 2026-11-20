export function storeView(value: string | null | undefined): 'apps' | 'themes' {
  return value === 'themes' ? 'themes' : 'apps';
}

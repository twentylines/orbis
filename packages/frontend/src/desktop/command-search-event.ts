export const commandSearchEvent = 'orbis-open-command-search';
export type CommandSearchScope = 'all' | 'apps' | 'settings' | 'monitor' | 'store';

export function commandSearchScope(event: Event): CommandSearchScope {
  const scope: unknown = event instanceof CustomEvent ? event.detail?.scope : undefined;
  return scope === 'apps' || scope === 'settings' || scope === 'monitor' || scope === 'store' ? scope : 'all';
}

export function openCommandSearch(scope: CommandSearchScope = 'all') {
  window.dispatchEvent(new CustomEvent(commandSearchEvent, { detail: { scope } }));
}

export const catalogueReturnEvent = 'orbis:catalogue-return';

export function requestCatalogueReturn(path: string) {
  if (path !== '/apps' && path !== '/app-store') return false;
  const event = new CustomEvent(catalogueReturnEvent, { cancelable: true, detail: { path } });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

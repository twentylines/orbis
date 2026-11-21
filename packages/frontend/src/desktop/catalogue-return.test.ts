import { expect, test } from 'bun:test';
import { catalogueReturnEvent, requestCatalogueReturn } from './catalogue-return';

test('only an owned catalogue can intercept its dock return', () => {
  const previous = globalThis.window;
  const target = new EventTarget();
  Object.assign(globalThis, { window: target });
  try {
    expect(requestCatalogueReturn('/apps')).toBe(false);
    let calls = 0;
    target.addEventListener(catalogueReturnEvent, (event) => {
      calls++;
      if ((event as CustomEvent).detail.path === '/apps') event.preventDefault();
    });
    expect(requestCatalogueReturn('/apps')).toBe(true);
    expect(requestCatalogueReturn('/app-store')).toBe(false);
    expect(requestCatalogueReturn('/settings')).toBe(false);
    expect(calls).toBe(2);
  } finally {
    Object.assign(globalThis, { window: previous });
  }
});

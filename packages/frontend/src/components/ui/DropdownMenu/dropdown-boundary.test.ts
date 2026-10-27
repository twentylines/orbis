import { expect, test } from 'bun:test';
import { dropdownBoundaryOptions } from './dropdown-boundary';

test('unscoped menus keep the existing body portal and viewport collision padding', () => {
  expect(dropdownBoundaryOptions(null)).toEqual({
    portal: { container: undefined },
    content: { collisionBoundary: undefined, collisionPadding: 16 },
  });
});

test('scoped menus use the identical app-settings viewport for placement and collision constraints', () => {
  const viewport = { id: 'synthetic-app-settings-viewport' } as HTMLElement;
  const options = dropdownBoundaryOptions(viewport);
  expect(options.portal.container).toBe(viewport);
  expect(options.content.collisionBoundary).toBe(viewport);
  expect(options.content.collisionPadding).toBe(8);
  expect(dropdownBoundaryOptions(null).portal.container).toBeUndefined();
});

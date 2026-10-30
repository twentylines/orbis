import { expect, test } from 'bun:test';
import { Children, isValidElement, type ReactElement, type ReactNode, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription } from '@/components/ui/Dialog';
import { AppearanceReset } from './appearance';

function descendants(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    return [child, ...descendants(child.props.children as ReactNode)];
  });
}

function resetSection(open = false) {
  const changes: boolean[] = [];
  let resets = 0;
  const tree = AppearanceReset({ open, onOpenChange: (value) => changes.push(value), onReset: () => resets++ });
  const nodes = descendants(tree);
  const buttons = nodes.filter((node) => node.type === Button) as ReactElement<ComponentProps<typeof Button>>[];
  const dialog = nodes.find((node) => node.type === Dialog) as ReactElement<ComponentProps<typeof Dialog>>;
  return { tree, nodes, buttons, dialog, changes, resets: () => resets };
}

test('reset has its own section and opening it never changes preferences', () => {
  const view = resetSection();
  const markup = renderToStaticMarkup(view.tree);
  expect(markup).toContain('Reset customisation');
  expect(markup).toContain('aria-labelledby="appearance-reset"');
  expect(markup).not.toContain('Import and export');
  expect(view.dialog.props.open).toBe(false);
  expect(view.resets()).toBe(0);
  view.buttons[0]?.props.onClick?.({} as never);
  expect(view.changes).toEqual([true]);
  expect(view.resets()).toBe(0);
});

test('Cancel and the dialog close callback cannot reset preferences', () => {
  const view = resetSection(true);
  const cancel = view.buttons.find((button) => button.props.children === 'Cancel');
  expect(cancel).toBeDefined();
  cancel?.props.onClick?.({} as never);
  view.dialog.props.onOpenChange?.(false);
  expect(view.changes).toEqual([false, false]);
  expect(view.resets()).toBe(0);
  const content = view.nodes.find((node) => node.type === DialogContent);
  expect(content?.props.onOpenAutoFocus).toBeUndefined();
});

test('only the confirmed Reset invokes the existing reset and closes the dialog', () => {
  const view = resetSection(true);
  const confirm = view.buttons.find((button) => button.props.intent === 'danger');
  expect(confirm?.props.children).toBe('Reset');
  expect(confirm?.props.type).toBe('button');
  confirm?.props.onClick?.({} as never);
  expect(view.resets()).toBe(1);
  expect(view.changes).toEqual([false]);
});

test('the warning covers workspace effects and makes the retained data explicit', () => {
  const view = resetSection(true);
  const description = view.nodes.find((node) => node.type === DialogDescription);
  const markup = renderToStaticMarkup(<Dialog open>{description}</Dialog>);
  for (const scope of [
    'Server display name',
    'light/dark mode',
    'text size and spacing',
    'Wallpaper',
    'motion, clock and dock',
    'Home layout and pins',
    'saved window positions',
    'app-opening preferences',
  ]) {
    expect(markup).toContain(scope);
  }
  expect(markup).toContain('selected theme pack and uploaded images are kept');
  expect(markup).toContain('Accounts, installed apps and their data are unchanged');
});

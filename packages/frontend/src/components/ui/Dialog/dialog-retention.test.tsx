import { expect, test } from 'bun:test';
import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Dialog, DialogOpenContext, retainDialogChildren, updateDialogOpen } from './Dialog';
function OpenProbe() {
  return <output data-open={useContext(DialogOpenContext)} />;
}
test('shared Dialog preserves controlled open and uncontrolled defaultOpen semantics', () => {
  expect(
    renderToStaticMarkup(
      <Dialog defaultOpen>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="true"');
  expect(
    renderToStaticMarkup(
      <Dialog>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="false"');
  expect(
    renderToStaticMarkup(
      <Dialog open={false} defaultOpen>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="false"');
  expect(
    renderToStaticMarkup(
      <Dialog open>
        <OpenProbe />
      </Dialog>,
    ),
  ).toContain('data-open="true"');
});
test('the real Root change handler calls onOpenChange exactly once and only owns uncontrolled state', () => {
  for (const controlled of [false, true]) {
    const state: boolean[] = [];
    const changes: boolean[] = [];
    updateDialogOpen(
      controlled,
      false,
      (value) => state.push(value),
      (value) => changes.push(value),
    );
    expect(state).toEqual(controlled ? [] : [false]);
    expect(changes).toEqual([false]);
  }
});
test('Presence-scoped retention keeps the entire last open tree through parent reset and replaces it on reopen', () => {
  const snapshot: { current: React.ReactNode } = { current: null };
  const populated = (
    <>
      <header>Create backup</header>
      <form>
        <input name="passphrase" />
        <button type="button">Continue</button>
      </form>
      <button type="button">Close</button>
    </>
  );
  const cleared = <header>Backup &amp; recovery</header>;
  expect(retainDialogChildren(snapshot, true, populated)).toBe(populated);
  expect(retainDialogChildren(snapshot, false, cleared)).toBe(populated);
  expect(renderToStaticMarkup(retainDialogChildren(snapshot, false, null))).toContain('Create backup');
  const reopened = <header>Another task</header>;
  expect(retainDialogChildren(snapshot, true, reopened)).toBe(reopened);
  expect(retainDialogChildren({ current: null }, false, cleared)).toBeNull();
});

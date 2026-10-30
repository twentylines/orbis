import { expect, mock } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as queries from '@tanstack/react-query';

const doc = {
  nodeType: 9,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: {} as object,
};
const win = { HTMLIFrameElement: class {}, HTMLElement: class {}, document: doc };
doc.defaultView = win;
Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });
let context = { isLoggedIn: true };
let finishCancellation!: () => void;
const client = {
  cancelQueries: () =>
    new Promise<void>((resolve) => {
      finishCancellation = resolve;
    }),
  removeQueries: () => undefined,
  getMutationCache: () => ({ clear: () => undefined }),
  setQueryData: (_key: unknown, next: { isLoggedIn: boolean }) => {
    context = next;
  },
  invalidateQueries: async () => undefined,
};
mock.module('@tanstack/react-query', () => ({ ...queries, useQueryClient: () => client, useSuspenseQuery: () => ({ data: context }) }));
const { UserContextProvider, useUserContext } = await import('../context/user-context');
let controls!: ReturnType<typeof useUserContext>;
function Probe() {
  controls = useUserContext();
  return null;
}
const container = {
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  textContent: '',
  appendChild: () => undefined,
  removeChild: () => undefined,
};
const root = createRoot(container as unknown as HTMLElement);
const render = () =>
  root.render(
    <UserContextProvider>
      <Probe />
    </UserContextProvider>,
  );
try {
  await act(async () => {
    render();
  });
  const original = controls.sessionEpoch;
  const originalSignal = controls.sessionAbortSignal;
  await act(async () => {
    await controls.refreshUserContext();
    render();
  });
  expect(controls.sessionEpoch).toBe(original);
  expect(originalSignal.aborted).toBe(false);
  await act(async () => {
    controls.setUserContext({ isLoggedIn: true });
    expect(originalSignal.aborted).toBe(true);
  });
  expect(controls.sessionEpoch).not.toBe(original);
  const loginSignal = controls.sessionAbortSignal;
  let ended!: Promise<void>;
  await act(async () => {
    ended = controls.endSession();
    expect(loginSignal.aborted).toBe(true);
    finishCancellation();
    await ended;
    render();
  });
  expect(controls.isLoggedIn).toBe(false);
  expect(controls.sessionAbortSignal.aborted).toBe(true);
  const signedOutEpoch = controls.sessionEpoch;
  await act(async () => {
    controls.setUserContext({ isLoggedIn: true });
  });
  expect(controls.sessionEpoch).not.toBe(signedOutEpoch);
  expect(controls.sessionAbortSignal.aborted).toBe(false);
  process.stdout.write(JSON.stringify({ scenario: 'user-session-lifetime', mountedReact: true, network: false, layout: false }));
} finally {
  await act(async () => {
    root.unmount();
  });
}

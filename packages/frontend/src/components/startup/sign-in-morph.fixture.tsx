import { expect, mock } from 'bun:test';
import { act } from 'react';
const noop = () => undefined;

const doc = {
  nodeType: 9,
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
  body: { nodeName: 'BODY' },
  defaultView: null as object | null,
  documentElement: { dataset: {} },
  querySelector: () => null,
};
const win = {
  HTMLIFrameElement: class {},
  HTMLElement: class {},
  document: doc,
  setTimeout,
  clearTimeout,
  addEventListener: noop,
  removeEventListener: noop,
};
doc.defaultView = win;
Object.assign(globalThis, { document: doc, window: win, IS_REACT_ACT_ENVIRONMENT: true });
let cancellations = 0;
let finishes = 0;
mock.module('@/desktop/session-motion', () => ({
  animateAuthExit: () => ({
    finished: Promise.resolve(),
    cancel: () => {
      cancellations++;
    },
  }),
}));
mock.module('@/desktop/motion-setting', () => ({ prefersReducedMotion: () => false }));
const session = {
  begin: noop,
  finish: async () => {
    finishes++;
  },
};
mock.module('./startup-boundary', () => ({ useStartupSession: () => session }));
const { createRoot } = await import('react-dom/client');
const { useSignInBoot } = await import('./use-sign-in-boot');
let boot!: ReturnType<typeof useSignInBoot>;
function Probe() {
  boot = useSignInBoot();
  return null;
}
const container = () => ({
  nodeType: 1,
  nodeName: 'DIV',
  tagName: 'DIV',
  ownerDocument: doc,
  addEventListener: noop,
  removeEventListener: noop,
  textContent: '',
  appendChild: noop,
  removeChild: noop,
});
const root = createRoot(container() as unknown as HTMLElement);
await act(async () => {
  root.render(<Probe />);
});
if (!boot) throw new Error('missing sign-in boot');
await act(async () => {
  boot?.begin(false);
});
await act(async () => {
  await boot?.finish();
});
await act(async () => root.unmount());
expect(cancellations).toBe(0);
expect(finishes).toBe(1);

const retry = createRoot(container() as unknown as HTMLElement);
await act(async () => {
  retry.render(<Probe />);
});
await act(async () => {
  boot?.begin(false);
});
await act(async () => {
  await boot?.finish(true);
});
expect(cancellations).toBe(1);
expect(finishes).toBe(2);
await act(async () => retry.unmount());
expect(cancellations).toBe(1);
process.stdout.write(JSON.stringify({ navigationKeepsPersistentMorph: true, failedHandoffRestoresFormOnce: true }));

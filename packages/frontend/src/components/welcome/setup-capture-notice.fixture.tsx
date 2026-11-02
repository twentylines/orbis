import { expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

let enabled = false;
let fetching = false;
let statusEnabled = false;
const receipt = { version: 1, attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', phase: 'submitted' };
mock.module('@/context/app-context', () => ({ useAppContext: () => ({ user: { id: 7, operator: true } }) }));
mock.module('@/context/user-context', () => ({ useUserContext: () => ({ sessionAbortSignal: new AbortController().signal }) }));
mock.module('@/desktop/preferences', () => ({ useDesktopPreferences: () => ({ onboardingGeneration: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }) }));
mock.module('./setup-capture', () => ({
  setupCaptureStorage: () => null,
  priorUnconfirmedSetupCapture: () => null,
  readSetupCapture: () => receipt,
  acknowledgeSetupCapture: () => {
    throw Error('Unexpected write');
  },
  reconcileSetupCapture: () => {
    throw Error('Unexpected capture');
  },
  retrySetupCaptureIfEnabled: () => {
    throw Error('Unexpected retry');
  },
}));
mock.module('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: () => undefined }),
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[0] === 'time-machine-preferences') return { data: { enabled }, isFetching: fetching, isError: false };
    if (options.queryKey[0] === 'setup-capture-status') {
      statusEnabled = options.enabled === true;
      return { isError: true, isFetching: false };
    }
    return { data: undefined };
  },
}));
const { SetupCaptureNotice } = await import('./setup-capture-notice');
const render = () =>
  renderToStaticMarkup(
    <MemoryRouter>
      <SetupCaptureNotice />
    </MemoryRouter>,
  );
expect(render()).toBe('');
expect(statusEnabled).toBe(false);
enabled = true;
fetching = true;
expect(render()).toBe('');
expect(statusEnabled).toBe(false);
fetching = false;
const shown = render();
expect(statusEnabled).toBe(true);
expect(shown).toContain('The setup capture is not confirmed');
expect(shown).toContain('Retry');
enabled = false;
expect(render()).toBe('');
expect(statusEnabled).toBe(false);
process.stdout.write(JSON.stringify({ disabledSuppressed: true, fetchingSuppressed: true, reenabledVisible: true }));

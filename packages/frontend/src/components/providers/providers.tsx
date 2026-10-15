import { UserContextProvider } from '@/context/user-context';
import { MutationCache, QueryClient, QueryClientProvider, QueryErrorResetBoundary } from '@tanstack/react-query';
import { type PropsWithChildren, Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorPage, FallbackSurface } from '../error/error-page';
import { I18nProvider } from './i18n/i18n-provider';
import { SentryProvider } from './sentry/sentry-provider';
import { AutoThemeProvider } from './theme/auto-theme-provider';
import { ThemeProvider } from './theme/theme-provider';
import { DebugPanel } from '../debug-panel/debug-panel';
import { DesktopPreferencesProvider } from '@/desktop/preferences';

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onSuccess: () => {
      queryClient.invalidateQueries();
    },
  }),
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

const PageSuspense = ({ children }: PropsWithChildren) => {
  return (
    <FallbackSurface>
      <output>Loading Orbis…</output>
      {children}
    </FallbackSurface>
  );
};

export const Providers = ({ children }: PropsWithChildren) => {
  return (
    <QueryClientProvider client={queryClient}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary fallbackRender={({ error, resetErrorBoundary }) => <ErrorPage error={error} onReset={resetErrorBoundary} />} onReset={reset}>
            <Suspense fallback={<PageSuspense />}>
              <UserContextProvider>
                <SentryProvider>
                  <ThemeProvider>
                    <AutoThemeProvider>
                      <I18nProvider>
                        <DesktopPreferencesProvider>{children}</DesktopPreferencesProvider>
                      </I18nProvider>
                    </AutoThemeProvider>
                  </ThemeProvider>
                </SentryProvider>
              </UserContextProvider>
            </Suspense>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
      <DebugPanel />
    </QueryClientProvider>
  );
};

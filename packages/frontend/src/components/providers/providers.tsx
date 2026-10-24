import { UserContextProvider } from '@/context/user-context';
import { QueryClientProvider, QueryErrorResetBoundary } from '@tanstack/react-query';
import { createAppQueryClient } from '@/lib/query-client';
import { type PropsWithChildren, Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { ErrorPage } from '../error/error-page';
import { I18nProvider } from './i18n/i18n-provider';
import { SentryProvider } from './sentry/sentry-provider';
import { AutoThemeProvider } from './theme/auto-theme-provider';
import { ThemeProvider } from './theme/theme-provider';
import { DebugPanel } from '../debug-panel/debug-panel';
import { DesktopPreferencesProvider, useDesktopPreferences } from '@/desktop/preferences';

const queryClient = createAppQueryClient();

const ThemedProviders = ({ children }: PropsWithChildren) => {
  const { resolvedMode } = useDesktopPreferences();
  return (
    <ThemeProvider colourMode={resolvedMode}>
      <AutoThemeProvider>
        <I18nProvider>{children}</I18nProvider>
      </AutoThemeProvider>
    </ThemeProvider>
  );
};

export const Providers = ({ children }: PropsWithChildren) => {
  return (
    <QueryClientProvider client={queryClient}>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary fallbackRender={({ error, resetErrorBoundary }) => <ErrorPage error={error} onReset={resetErrorBoundary} />} onReset={reset}>
            <Suspense fallback={null}>
              <UserContextProvider>
                <SentryProvider>
                  <DesktopPreferencesProvider>
                    <ThemedProviders>{children}</ThemedProviders>
                  </DesktopPreferencesProvider>
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

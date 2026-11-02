import { ReceiverRequestProvider } from '@/modules/host-transfer/receiver-request-context';
import { AppContextProvider } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { GuestDashboard } from '@/modules/dashboard/pages/guest-dashboard';
import { QueryErrorResetBoundary } from '@tanstack/react-query';
import { Suspense } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ErrorPage } from '../error/error-page';
import { DashboardLayout, DashboardLayoutSuspense } from '../layouts/dashboard/layout';
import { SSEProvider } from '../providers/sse/sse-provider';
import { RouteWrapper } from './route-wrapper';
import { safeReturnTo } from '@/desktop/secure-access';
import { authenticatedSessionId } from '@/components/startup/auth-session-navigation';

export default () => {
  const { isLoggedIn, isGuestDashboardEnabled } = useUserContext();
  const { pathname, search, hash } = useLocation();

  if (!isLoggedIn && !isGuestDashboardEnabled) {
    const target = safeReturnTo(pathname + search + hash);
    let sessionId: string | null = null;
    try {
      sessionId = authenticatedSessionId(window.sessionStorage);
    } catch {
      /* Storage is optional. */
    }
    return (
      <Navigate
        to={target ? `/login?${new URLSearchParams({ return_to: target })}` : '/login'}
        state={sessionId && target ? { orbisSessionRecovery: target, orbisSessionId: sessionId } : null}
        replace
      />
    );
  }

  if (isGuestDashboardEnabled && !isLoggedIn) {
    return <GuestDashboard />;
  }

  return (
    <RouteWrapper>
      <QueryErrorResetBoundary>
        {({ reset }) => (
          <ErrorBoundary
            resetKeys={[pathname]}
            fallbackRender={({ error, resetErrorBoundary }) => <ErrorPage error={error} onReset={resetErrorBoundary} />}
            onReset={reset}
          >
            <Suspense fallback={<DashboardLayoutSuspense />}>
              <AppContextProvider>
                <ReceiverRequestProvider>
                  <SSEProvider>
                    <Suspense fallback={<DashboardLayout />}>
                      <DashboardLayout>
                        <Outlet />
                      </DashboardLayout>
                    </Suspense>
                  </SSEProvider>
                </ReceiverRequestProvider>
              </AppContextProvider>
            </Suspense>
          </ErrorBoundary>
        )}
      </QueryErrorResetBoundary>
    </RouteWrapper>
  );
};

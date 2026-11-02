import { rememberLogout } from '@/desktop/session-motion';
import { Suspense, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { AuthLayout } from '../layouts/auth/layout';
import { RouteWrapper } from './route-wrapper';

export default function UnauthenticatedRoute() {
  const { pathname } = useLocation();
  const setup = pathname === '/register';
  useEffect(() => rememberLogout(false), []);
  return (
    <RouteWrapper>
      <Suspense fallback={<AuthLayout setup={setup} />}>
        <AuthLayout setup={setup}>
          <Outlet />
        </AuthLayout>
      </Suspense>
    </RouteWrapper>
  );
}

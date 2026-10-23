import { rememberLogout } from '@/desktop/session-motion';
import { Suspense, useEffect } from 'react';
import { Outlet } from 'react-router';
import { AuthLayout } from '../layouts/auth/layout';
import { RouteWrapper } from './route-wrapper';

export default () => {
  useEffect(() => rememberLogout(false), []);
  return (
    <RouteWrapper>
      <Suspense fallback={<AuthLayout />}>
        <AuthLayout>
          <Outlet />
        </AuthLayout>
      </Suspense>
    </RouteWrapper>
  );
};

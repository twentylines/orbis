import { DelayedRouteLoading } from '@/desktop/route-loading';
import { Suspense } from 'react';
import { useParams } from 'react-router';
import { AppPreviewLayout } from './app-preview-layout';
import MyAppsPage from './my-apps-page';

export default function InstalledAppsLayout() {
  const { appId, storeId, serverId } = useParams<{ appId: string; storeId: string; serverId: string }>();
  return (
    <AppPreviewLayout source="installed" selected={appId ? `${serverId ? `${serverId}/` : ''}${appId}:${storeId ?? '_user'}` : null}>
      <Suspense fallback={<DelayedRouteLoading label="Loading installed apps…" />}>
        <MyAppsPage />
      </Suspense>
    </AppPreviewLayout>
  );
}

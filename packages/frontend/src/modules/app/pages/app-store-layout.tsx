import { Suspense } from 'react';
import { useParams } from 'react-router';
import { AppPreviewLayout } from './app-preview-layout';
import AppStorePage, { AppStorePageSuspense } from './app-store-page';

export default function AppStoreLayout() {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();
  return (
    <AppPreviewLayout source="store" selected={appId && storeId ? `${appId}:${storeId}` : null}>
      <Suspense fallback={<AppStorePageSuspense />}>
        <AppStorePage />
      </Suspense>
    </AppPreviewLayout>
  );
}

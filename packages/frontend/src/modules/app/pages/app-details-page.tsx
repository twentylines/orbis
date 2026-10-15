import { getAppOptions } from '@/api-client/@tanstack/react-query.gen';
import { useSuspenseQuery } from '@tanstack/react-query';
import { redirect, useParams } from 'react-router';
import { AppWorkspace } from '../containers/app-workspace/app-workspace';
import type { Route } from './+types/app-details-page';
import { shouldRevalidateToolRoute } from '@/desktop/window-navigation';

export const shouldRevalidate = shouldRevalidateToolRoute;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const { storeId } = params;

  if (storeId === '_user') {
    return redirect(`/apps/${params.appId}`);
  }
}

export default () => {
  const { appId, storeId } = useParams<{ appId: string; storeId: string }>();

  const getApp = useSuspenseQuery({
    ...getAppOptions({ path: { urn: `${appId}:${storeId}` } }),
  });

  const { info, app, metadata } = getApp.data;

  return <AppWorkspace info={info} app={app} metadata={metadata} />;
};

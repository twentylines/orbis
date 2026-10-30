import type { GetAppDto } from '@/api-client';
import { getAppQueryKey } from '@/api-client/@tanstack/react-query.gen';
import type { AppStatus } from '@/types/app.types';
import { useQueryClient } from '@tanstack/react-query';

export const useAppStatus = () => {
  const queryClient = useQueryClient();

  const setOptimisticStatus = (status: AppStatus, appUrn: string) => {
    const [appName, appStoreId] = appUrn.split(':');

    if (!appName || !appStoreId) {
      console.error('setOptimisticStatus -> Invalid app urn', appUrn);
      return;
    }

    const queryKey = getAppQueryKey({ path: { urn: appUrn } });
    queryClient.setQueryData<GetAppDto>(queryKey, (data) => {
      if (!data?.app) return data;
      return { ...data, app: { ...data.app, status } };
    });
  };

  return {
    setOptimisticStatus,
  };
};

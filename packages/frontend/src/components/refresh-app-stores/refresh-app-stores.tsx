import {
  getAllAppStoresQueryKey,
  getEnabledAppStoresQueryKey,
  pullAppStoresMutation,
  searchAppsQueryKey,
} from '@/api-client/@tanstack/react-query.gen';
import { Button } from '@/components/ui/Button';
import type { TranslatableError } from '@/types/error.types';
import { IconRefresh } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import './refresh-app-stores.css';

export function RefreshAppStoresButton() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [showProgress, setShowProgress] = useState(false);
  const refresh = useMutation({
    ...pullAppStoresMutation(),
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getAllAppStoresQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getEnabledAppStoresQueryKey() }),
        queryClient.invalidateQueries({ queryKey: searchAppsQueryKey() }),
      ]);
      toast.success('App stores refreshed.');
    },
    onError: (error: TranslatableError) => toast.error(t(error.message, error.intlParams)),
  });
  useEffect(() => {
    if (!refresh.isPending) {
      setShowProgress(false);
      return;
    }
    const timer = window.setTimeout(() => setShowProgress(true), 350);
    return () => window.clearTimeout(timer);
  }, [refresh.isPending]);
  return (
    <Button
      className="refresh-app-stores"
      onClick={() => refresh.mutate({})}
      disabled={refresh.isPending}
      aria-busy={refresh.isPending || undefined}
      data-progress={showProgress || undefined}
    >
      <IconRefresh size={18} aria-hidden="true" />
      <span>{showProgress ? 'Refreshing stores…' : 'Refresh stores'}</span>
    </Button>
  );
}

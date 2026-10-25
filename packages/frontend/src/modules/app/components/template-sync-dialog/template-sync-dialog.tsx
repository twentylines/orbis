import { getTemplateDiff, syncWithTemplate } from '@/api-client';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { ScrollArea } from '@/components/ui/ScrollArea';
import type { TranslatableError } from '@/types/error.types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

const TemplateDiff = lazy(() => import('./template-diff').then((module) => ({ default: module.TemplateDiff })));

interface TemplateSyncDialogProps {
  appUrn: string;
  isOpen: boolean;
  onClose: () => void;
}

export const TemplateSyncDialog = ({ appUrn, isOpen, onClose }: TemplateSyncDialogProps) => {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<'overview' | 'diff'>('overview');

  const { data: diffData, isLoading } = useQuery({
    queryKey: ['template-diff', appUrn],
    queryFn: () => getTemplateDiff({ path: { urn: appUrn } }),
    enabled: isOpen && Boolean(appUrn),
  });

  const syncMutation = useMutation({
    mutationFn: () => syncWithTemplate({ path: { urn: appUrn } }),
    onSuccess: () => {
      toast.success(t('APP_SYNC_SUCCESS'));
      onClose();
    },
    onError: (error: TranslatableError) => {
      toast.error(t(error.message || 'APP_SYNC_ERROR'));
    },
  });

  if (isLoading) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('APP_SYNC_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription>{t('APP_ACTION_LOADING')}</DialogDescription>
        </DialogContent>
      </Dialog>
    );
  }

  const diff = diffData?.data;

  if (!diff?.hasChanges) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('APP_SYNC_TITLE')}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <p>{t('APP_SYNC_NO_CHANGES')}</p>
          </DialogDescription>
          <DialogFooter>
            <Button onClick={onClose}>{t('CLOSE')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{t('APP_SYNC_TITLE')}</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          <div className="mb-3">
            <div className="d-flex justify-content-between align-items-center mb-3">
              <span>
                {t('APP_SYNC_VERSIONS', {
                  local: diff.localVersion,
                  template: diff.templateVersion,
                })}
              </span>
              <Button variant="outline" size="sm" onClick={() => setViewMode(viewMode === 'overview' ? 'diff' : 'overview')}>
                {viewMode === 'overview' ? t('APP_SYNC_VIEW_DIFF') : t('APP_SYNC_VIEW_OVERVIEW')}
              </Button>
            </div>

            {viewMode === 'diff' && (
              <ScrollArea maxheight={500}>
                <Suspense
                  fallback={
                    <output className="d-flex align-items-center justify-content-center" style={{ minHeight: 400 }}>
                      {t('APP_ACTION_LOADING')}
                    </output>
                  }
                >
                  <TemplateDiff label={t('APP_SYNC_TITLE')} original={diff.current || ''} template={diff.template || ''} />
                </Suspense>
              </ScrollArea>
            )}

            {viewMode === 'overview' && <div className="alert alert-warning">{t('APP_SYNC_WARNING')}</div>}
          </div>
        </DialogDescription>
        <DialogFooter className="d-flex justify-content-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('CANCEL')}
          </Button>
          <Button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} loading={syncMutation.isPending}>
            {t('APP_SYNC_CONFIRM')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

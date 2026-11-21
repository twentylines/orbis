import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { restartApp, startApp, stopApp } from '@/api-client';
import { useUserContext } from '@/context/user-context';
import { useAppContext } from '@/context/app-context';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import type { AppCommand } from './search-intent';

export type SearchAppAction = { action: AppCommand; urn: string; name: string };
const labels = { start: 'Start', stop: 'Stop', restart: 'Restart' };
export default function SearchAppActionDialog({ request, onClose }: { request: SearchAppAction; onClose: () => void }) {
  const { sessionAbortSignal } = useUserContext();
  const { user } = useAppContext();
  const [error, setError] = useState(false);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!user.operator || sessionAbortSignal.aborted) throw new Error('Session unavailable');
      setError(false);
      const options = { path: { urn: request.urn }, signal: sessionAbortSignal, throwOnError: true as const };
      if (request.action === 'start') await startApp(options);
      else if (request.action === 'stop') await stopApp(options);
      else await restartApp(options);
    },
    onSuccess: onClose,
    onError: () => setError(true),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            {labels[request.action]} {request.name}?
          </DialogTitle>
        </DialogHeader>
        <DialogDescription>
          {request.action === 'start'
            ? 'Start this app and its services.'
            : request.action === 'restart'
              ? 'All data will be retained. The app will be briefly unavailable while it restarts.'
              : 'The app will be unavailable until it is started again. Its data will be retained.'}
        </DialogDescription>
        {error ? <p role="alert">The action could not be completed. Check the app and try again.</p> : null}
        <DialogFooter>
          <Button intent="secondary" disabled={mutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button intent={request.action === 'start' ? 'primary' : 'danger'} loading={mutation.isPending} onClick={() => mutation.mutate()}>
            {labels[request.action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

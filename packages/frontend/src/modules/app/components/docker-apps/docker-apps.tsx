import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBrandDocker, IconRefresh, IconTrash } from '@tabler/icons-react';
import type { DockerApp, DockerAppRemoval, DockerApps } from '@runtipi/common/schemas';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { useWindowVisible } from '@/desktop/window-visibility';
import { containerTelemetryKey } from '@/desktop/containers';
import './docker-apps.css';

const inventoryKey = ['docker-apps'] as const;
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { credentials: 'include', signal, cache: 'no-store' });
  if (!response.ok) throw new Error('Docker apps could not be loaded. Refresh to try again.');
  return response.json();
}

export function DockerAppsSection() {
  const visible = useWindowVisible();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<DockerApp | null>(null);
  const section = useRef<HTMLElement>(null);
  const reviewAppId = useRef<string | null>(null);
  const completedAppId = useRef<string | null>(null);
  const inventory = useQuery({
    queryKey: inventoryKey,
    queryFn: ({ signal }) => read<DockerApps>('/api/docker-apps', signal),
    enabled: visible,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    staleTime: 10000,
  });
  const review = useQuery({
    queryKey: ['docker-app-removal', selected?.id],
    queryFn: ({ signal }) => read<DockerAppRemoval>(`/api/docker-apps/${selected?.id}/uninstall`, signal),
    enabled: visible && selected !== null,
    staleTime: 0,
    retry: false,
  });
  const uninstall = useMutation({
    mutationFn: async (plan: DockerAppRemoval) => {
      const response = await fetch(`/api/docker-apps/${plan.app.id}/uninstall`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewId: plan.reviewId, name: plan.app.name }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(typeof error?.message === 'string' ? error.message : 'Uninstall did not finish. Refresh to review the remaining containers.');
      }
    },
    onSuccess: (_data, plan) => {
      completedAppId.current = plan.app.id;
      if (document.activeElement?.closest('[data-docker-app-id]')?.getAttribute('data-docker-app-id') === plan.app.id) section.current?.focus();
      setSelected((current) => (current?.id === plan.app.id ? null : current));
      toast.success('App uninstalled. Persistent data was retained.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: inventoryKey });
      void queryClient.invalidateQueries({ queryKey: containerTelemetryKey });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const openReview = (app: DockerApp) => {
    uninstall.reset();
    reviewAppId.current = app.id;
    setSelected(app);
  };
  const count = inventory.data?.apps.reduce((sum, app) => sum + app.containers.length, 0) ?? 0;

  return (
    <section ref={section} className="docker-apps-section" aria-labelledby="docker-apps-title" tabIndex={-1} data-dialog-focus-fallback>
      <header className="docker-apps-heading">
        <div>
          <h2 id="docker-apps-title">Docker apps</h2>
          <p>Apps detected outside your Orbis app library.</p>
        </div>
        <Button onClick={() => inventory.refetch()} disabled={inventory.isFetching}>
          <IconRefresh size={18} aria-hidden="true" /> Refresh
        </Button>
      </header>
      {inventory.isPending ? <output>Checking Docker apps…</output> : null}
      {inventory.isError ? (
        <p className="workspace-message is-error" role="alert">
          Docker apps could not be loaded. Refresh to try again.
        </p>
      ) : null}
      {inventory.data ? (
        <>
          <p className="docker-apps-count">
            {inventory.data.apps.length} {inventory.data.apps.length === 1 ? 'app' : 'apps'} · {count} {count === 1 ? 'container' : 'containers'}
          </p>
          {inventory.data.apps.length === 0 ? (
            <p className="docker-apps-empty">No additional Docker apps found.</p>
          ) : (
            <ul className="docker-apps-grid">
              {inventory.data.apps.map((app) => (
                <li key={app.id} className="docker-app-card">
                  <span className="docker-app-icon">
                    <IconBrandDocker size={28} stroke={1.5} aria-hidden="true" />
                  </span>
                  <div className="docker-app-copy">
                    <h3 title={app.name}>{app.name}</h3>
                    <p>
                      {app.running} running · {app.containers.length} {app.containers.length === 1 ? 'container' : 'containers'}
                    </p>
                    {app.source === 'runtipi' ? <p className="docker-app-origin">Runtipi configuration not imported</p> : null}
                  </div>
                  <Button onClick={() => openReview(app)} aria-label={`Review uninstall for ${app.name}`} data-docker-app-id={app.id}>
                    <IconTrash size={18} aria-hidden="true" /> Uninstall
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent
          type="danger"
          size="md"
          className="docker-app-removal"
          onCloseAutoFocus={(event) => {
            if (reviewAppId.current === completedAppId.current) {
              event.preventDefault();
              section.current?.focus();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Uninstall <span className="docker-app-identifier">{selected?.name}</span>?
            </DialogTitle>
          </DialogHeader>
          <div className="docker-app-removal-scroll">
            <DialogDescription className="docker-app-removal-summary">
              Stop and remove this app’s containers. Bind-mounted files and Docker volumes are kept. Changes stored only inside the containers will be
              removed.
            </DialogDescription>
            <div className="docker-app-review-body">
              {review.isPending ? <output>Checking containers and storage…</output> : null}
              {review.isError ? (
                <p className="workspace-message is-error" role="alert">
                  The app could not be inspected. Refresh the review before uninstalling.
                </p>
              ) : null}
              {review.data ? (
                <>
                  <h3>Containers to remove</h3>
                  <ul className="docker-app-review-list">
                    {review.data.app.containers.map((container) => (
                      <li key={container.id}>
                        <span className="docker-app-identifier">{container.name}</span>
                        <span>{container.state}</span>
                      </li>
                    ))}
                  </ul>
                  <h3>Storage retained</h3>
                  {review.data.storage.length ? (
                    <ul className="docker-app-storage-list">
                      {review.data.storage.map((storage) => (
                        <li key={`${storage.type}:${storage.name}:${storage.destination}`}>
                          <span>{storage.type === 'bind' ? 'Folder' : 'Volume'}</span>
                          <code className="docker-app-identifier">{storage.name}</code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>No persistent storage mounts were detected.</p>
                  )}
                  {review.data.app.unavailableReason ? (
                    <p role="alert" className="workspace-message">
                      {review.data.app.unavailableReason}
                    </p>
                  ) : null}
                </>
              ) : null}
              {uninstall.isError ? (
                <p role="alert" className="workspace-message is-error">
                  {uninstall.error.message}
                </p>
              ) : null}
              {uninstall.isPending ? <output>Uninstalling… Closing this window will not cancel it. Check progress in Tasks.</output> : null}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setSelected(null)}>{uninstall.isPending ? 'Close' : 'Cancel'}</Button>
            {review.isError || uninstall.isError ? (
              <Button onClick={() => review.refetch()} disabled={review.isFetching || uninstall.isPending}>
                Refresh review
              </Button>
            ) : null}
            <Button
              intent="danger"
              disabled={!review.data?.app.removable || review.isError || review.isFetching}
              loading={uninstall.isPending}
              onClick={() => {
                if (review.data) uninstall.mutate(review.data);
              }}
            >
              Uninstall app
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

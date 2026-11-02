import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SmartToolsPlan } from '@runtipi/common/schemas/drive-health';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { reviewSmartTools, smartToolsRequest, SmartToolsRequestError, type SmartToolsJob } from '@/desktop/smart-tools';

export function SmartToolsInstaller({
  serverId,
  drivePath,
  missing,
  visible,
}: {
  serverId?: string | null;
  drivePath: string;
  missing: boolean;
  visible: boolean;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<SmartToolsPlan | null>(null);
  const [requested, setRequested] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: () => reviewSmartTools(serverId),
    onSuccess: setPlan,
  });
  const status = useQuery({
    queryKey: ['smart-tools-job', serverId ?? 'local'],
    queryFn: () => smartToolsRequest<{ available: boolean; job: SmartToolsJob | null }>('status', {}, serverId),
    enabled: visible && (missing || requested !== null),
    retry: false,
    refetchInterval: (query) => (['queued', 'running'].includes(query.state.data?.job?.state ?? '') || requested ? 1500 : 30_000),
    refetchIntervalInBackground: false,
  });
  const job = status.data?.job;
  const installing = job?.kind === 'smart-tools' && ['queued', 'running'].includes(job.state);
  const blocked = job && ['queued', 'running', 'failed', 'interrupted'].includes(job.state);
  const install = useMutation({
    mutationFn: async () => {
      if (!plan || Date.now() >= plan.expiresAt * 1000) throw new Error('This installation review expired. Cancel and review it again.');
      setRequested(plan.planId);
      const accepted = await smartToolsRequest<{ jobId: string; state: string }>('apply', { planId: plan.planId }, serverId);
      if (accepted.jobId !== plan.planId || !['queued', 'running'].includes(accepted.state))
        throw new Error('Installation was not confirmed. Refresh task status.');
      return accepted;
    },
    onSuccess: () => {
      setOpen(false);
      void status.refetch();
      void client.invalidateQueries({ queryKey: ['orbis-host-package-job'] });
    },
    onError: (error) => {
      if (error instanceof SmartToolsRequestError && error.rejected) setRequested(null);
      void status.refetch();
    },
  });
  useEffect(() => {
    if (job?.kind !== 'smart-tools' || !['complete', 'failed', 'interrupted'].includes(job.state)) return;
    if (requested === job.id) setRequested(null);
    if (job.state === 'complete') {
      setOpen(false);
      void client.invalidateQueries({ queryKey: ['drive-health', drivePath] });
    }
  }, [job?.id, job?.kind, job?.state, requested, client, drivePath]);
  const waiting = review.isPending || install.isPending;
  return (
    <div className="drive-health-smart-tools">
      {missing ? (
        <>
          <p>smartmontools reads the health information built into physical drives. Orbis uses the official Ubuntu package.</p>
          <div className="drive-health-actions">
            <button
              className="btn btn-primary"
              type="button"
              disabled={Boolean(blocked) || requested !== null}
              onClick={() => {
                setPlan(null);
                install.reset();
                setOpen(true);
                review.mutate();
              }}
            >
              {installing ? 'Installing SMART tools…' : 'Install SMART tools'}
            </button>
          </div>
        </>
      ) : null}
      {installing ? (
        <output className="workspace-message">Installing SMART tools. Drive health will refresh when installation finishes.</output>
      ) : null}
      {job?.kind === 'smart-tools' && ['failed', 'interrupted'].includes(job.state) ? (
        <p role="alert">{job.message || 'Installation stopped. Inspect the host package transaction before retrying.'}</p>
      ) : null}
      {blocked && !installing && job?.kind !== 'smart-tools' ? (
        <p>Finish the current host package transaction before installing SMART tools.</p>
      ) : null}
      {requested && !installing ? <output>Checking the installation request. Refresh task status before retrying.</output> : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!waiting) setOpen(value);
        }}
      >
        <DialogContent size="sm" closeDisabled={waiting} className="drive-health-confirmation-dialog">
          <DialogHeader>
            <DialogTitle>Install SMART tools?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <p>
              Install smartmontools from Ubuntu’s trusted package repository. Background monitoring stays as configured; this action does not enable
              it or start a disk test.
            </p>
            {review.isPending ? <output>Reviewing the host package requirements…</output> : null}
            {plan ? (
              <ul>
                {plan.selected.map((item) => (
                  <li key={item.name}>
                    {item.name} · {item.candidateVersion}
                  </li>
                ))}
              </ul>
            ) : null}
            {review.isError ? <p role="alert">{review.error.message}</p> : null}
            {install.isError ? <p role="alert">{install.error.message}</p> : null}
            {status.isError && requested ? <p role="alert">Task status is unavailable. The installation may still be running.</p> : null}
          </DialogDescription>
          <DialogFooter>
            <button className="btn" type="button" disabled={waiting} onClick={() => setOpen(false)}>
              Cancel
            </button>
            {requested ? (
              <button className="btn btn-primary" type="button" disabled={status.isFetching} onClick={() => void status.refetch()}>
                Refresh status
              </button>
            ) : (
              <button className="btn btn-primary" type="button" disabled={waiting || !plan || Boolean(blocked)} onClick={() => install.mutate()}>
                {install.isPending ? 'Starting installation…' : 'Install'}
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

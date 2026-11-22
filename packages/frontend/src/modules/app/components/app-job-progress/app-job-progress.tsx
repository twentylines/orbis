import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlayerStop } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { appJobResponseSchema } from '@runtipi/common/schemas/app-job';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import { cancelAppJob, getAppJob } from '@/api-client/sdk.gen';
import { Button } from '@/components/ui/Button';
import { useWindowVisible } from '@/desktop/window-visibility';
import { taskProgressLabel } from '@/desktop/task-progress';
import { taskStates } from '@/desktop/tasks';
import { createServerClock, jobElapsed } from './app-job-time';
import './app-job-progress.css';

export function AppJobCancel({
  appUrn,
  requestId,
  owner,
  cancellable,
  status,
}: {
  appUrn: string;
  requestId: string;
  owner: string;
  cancellable: boolean;
  status: TaskRecord['status'];
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const cancel = useMutation({
    mutationKey: ['app-job-cancel', owner, appUrn, requestId],
    mutationFn: () => cancelAppJob({ path: { urn: appUrn, requestId }, throwOnError: true }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: ['app-job', owner, appUrn] });
    },
  });
  if (!cancellable && status !== 'cancelling' && !cancel.isPending && !cancel.isError) return null;
  return (
    <div className="app-job-control">
      <Button intent="secondary" disabled={!cancellable || cancel.isPending || status === 'cancelling'} onClick={() => cancel.mutate()}>
        <IconPlayerStop size={17} aria-hidden="true" />
        {cancel.isPending || status === 'cancelling'
          ? t('APP_JOB_CANCELLING', { defaultValue: 'Cancelling…' })
          : t('APP_JOB_CANCEL', { defaultValue: 'Cancel operation' })}
      </Button>
      {cancel.isError ? (
        <span role="alert">
          {t('APP_JOB_CANCEL_ERROR', { defaultValue: 'Cancellation could not be confirmed. Refresh the operation before trying again.' })}
        </span>
      ) : null}
    </div>
  );
}

export function AppJobProgress({ appUrn, owner }: { appUrn: string; owner: string }) {
  const { t } = useTranslation();
  const visible = useWindowVisible();
  const clock = useRef(createServerClock());
  const [, tick] = useState(0);
  const query = useQuery({
    queryKey: ['app-job', owner, appUrn],
    enabled: visible,
    queryFn: async ({ signal }) => {
      const result = await getAppJob({ path: { urn: appUrn }, signal, throwOnError: true });
      const parsed = appJobResponseSchema.assert(result.data);
      if (parsed.job && parsed.job.appUrn !== appUrn) throw new Error('Operation identity changed.');
      clock.current.observe(Date.parse(result.response.headers.get('date') ?? ''));
      return parsed.job;
    },
    refetchInterval: 1000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const job = query.data;
  const active = !!job && ['queued', 'running', 'cancelling'].includes(job.status);
  useEffect(() => {
    if (!active || !visible) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active, visible]);
  if (!job)
    return query.isError ? (
      <output className="app-job-progress">
        {t('APP_JOB_UNAVAILABLE', { defaultValue: 'Operation status is unavailable. Check Task Centre before retrying.' })}
      </output>
    ) : null;
  const phase = taskProgressLabel({ action: job.command, status: job.status, phase: job.phase }) ?? taskStates[job.status];
  const elapsed = jobElapsed(job, clock.current.now());
  return (
    <section className="app-job-progress" aria-label={t('APP_JOB_PROGRESS', { defaultValue: 'Application operation' })}>
      <div className="app-job-copy">
        <strong>{phase}</strong>
        {elapsed ? (
          <span>
            {t('APP_JOB_ELAPSED', { defaultValue: 'Elapsed' })} · {elapsed}
          </span>
        ) : null}
        {query.isError ? <output>{t('APP_JOB_STALE', { defaultValue: 'Showing the last reported state. Reconnecting…' })}</output> : null}
        {active && !job.cancellable && job.status !== 'cancelling' ? (
          <small>{t('APP_JOB_FINISHING', { defaultValue: 'Finishing or recovering the application. Cancellation is unavailable.' })}</small>
        ) : null}
      </div>
      <AppJobCancel
        key={`${owner}:${job.requestId}`}
        owner={owner}
        appUrn={appUrn}
        requestId={job.requestId}
        cancellable={!query.isError && job.cancellable}
        status={job.status}
      />
    </section>
  );
}

import { queryOptions, useQuery } from '@tanstack/react-query';
import {
  parseSentinelUpdateProgress,
  sentinelUpdateActive,
  sentinelUpdateProgressMaxBytes,
  type SentinelUpdateJob,
} from '@runtipi/common/schemas/sentinel-update-progress';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { readSentinelJson, SentinelStatusError } from './sentinel-status';

const phaseLabels: Record<SentinelUpdateJob['phase'], string> = {
  preparing: 'Preparing Sentinel update',
  downloading: 'Downloading Sentinel update files',
  verifying: 'Verifying Sentinel publisher',
  staging: 'Staging verified Sentinel files',
  prepared: 'Sentinel verified and prepared for activation',
  installing: 'Installing and checking Sentinel',
  'rolling-back': 'Rolling back Sentinel',
  'rolled-back': 'Sentinel update failed and was rolled back',
  'recovery-required': 'Sentinel update requires recovery review',
  failed: 'Sentinel update failed',
  interrupted: 'Sentinel update interrupted. Check the host before retrying.',
  complete: 'Sentinel updated and health verified',
};

const fileLabels: Record<NonNullable<SentinelUpdateJob['download']>['file'], string> = {
  'activation-tool': 'Activation tool',
  'verification-tool': 'Verification tool',
  'staging-tool': 'Staging tool',
  'verifier-bootstrap': 'Verifier bootstrap',
  'toolkit-license': 'Toolkit license',
  verifier: 'Verifier',
  release: 'Sentinel release',
  signature: 'Publisher signature',
};

export function describeSentinelUpdate(job: SentinelUpdateJob) {
  const status = phaseLabels[job.phase];
  const download = job.download;
  if (!download) return { status };
  const { currentBytes, totalBytes } = download;
  return {
    status,
    detail: `${fileLabels[download.file]} · ${formatBackupBytes(currentBytes)}${totalBytes === null ? ' downloaded' : ` of ${formatBackupBytes(totalBytes)}`}`,
    // Once the bytes arrive the file may still be checked. The update never shows 100% in flight.
    percentage: totalBytes !== null && currentBytes < totalBytes ? Math.floor((currentBytes / totalBytes) * 100) : undefined,
  };
}

export async function readSentinelUpdateProgress(signal: AbortSignal) {
  const value = await readSentinelJson('/api/system/sentinel/update-progress', signal, sentinelUpdateProgressMaxBytes);
  const parsed = parseSentinelUpdateProgress(value);
  if (!parsed) throw new SentinelStatusError();
  return parsed;
}

const sessionKeys = new WeakMap<AbortSignal, number>();
let nextSessionKey = 0;

export function sentinelUpdateProgressOptions(userId: number | string, session: AbortSignal, enabled: boolean, poll: boolean) {
  let epoch = sessionKeys.get(session);
  if (epoch === undefined) {
    epoch = ++nextSessionKey;
    sessionKeys.set(session, epoch);
  }
  return queryOptions({
    queryKey: ['orbis-sentinel-update-progress', userId, epoch],
    queryFn: ({ signal }) => readSentinelUpdateProgress(AbortSignal.any([signal, session])),
    enabled: enabled && !session.aborted,
    refetchInterval: (query) => {
      if (!poll || !enabled || session.aborted) return false;
      if (query.state.error instanceof SentinelStatusError && [401, 403].includes(query.state.error.status ?? 0)) return false;
      if (query.state.error || query.state.data?.available === false) return 10_000;
      return query.state.data?.jobs.some(sentinelUpdateActive) ? 1000 : 2000;
    },
    refetchIntervalInBackground: false,
    staleTime: 1000,
    retry: false,
  });
}

export function useSentinelUpdateProgress(active: boolean, poll = false) {
  const { user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const allowed = user.operator === true && !sessionAbortSignal.aborted;
  const query = useQuery(sentinelUpdateProgressOptions(user.id, sessionAbortSignal, allowed && active && visible, poll));
  const unavailable = allowed && (query.isError || query.data?.available === false);
  return {
    jobs: allowed && !unavailable ? (query.data?.jobs ?? []) : [],
    unavailable,
    pending: allowed && query.isPending && !query.isError,
  };
}

export type SentinelUpdateView = ReturnType<typeof useSentinelUpdateProgress>;

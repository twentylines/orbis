import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Markdown } from '@/components/markdown/markdown';
import { useAppContext } from '@/context/app-context';
import { clusterRequest, useCluster, type ClusterServer } from './cluster';
import { useWindowVisible } from './window-visibility';
import './cluster-updates.css';

type AppUpdates = {
  installed: { app: { version: number; ignoredVersion: number | null }; info: { urn: string; name: string }; metadata: { latestVersion: number } }[];
};
type Release = { tag: string; body: string; url: string; imageManifestUrl: string | null };
type Status = {
  available: boolean;
  enrolled?: boolean;
  currentTag?: string;
  imageMatches?: boolean;
  coreState?: string;
  coreHealth?: string;
  reason?: string;
  job?: { state: string; targetTag: string; message?: string };
};
type Inventory = { apps: AppUpdates; build: { version: string }; release: Release | null; releaseFailed: boolean; status: Status | null };
type Plan = { planId: string; targetTag: string; currentTag: string; snapshotBytes: number; appsMustBeStopped: boolean };
type Outcome = { server: string; message: string; failed: boolean };
const serverPath = (id: string) => `/servers/${encodeURIComponent(id)}`;
const read = <T,>(id: string, resource: string) => clusterRequest<T>(`${serverPath(id)}/read/${resource}`);
const command = <T,>(id: string, action: string, payload?: object) => clusterRequest<T>(`${serverPath(id)}/command`, 'POST', { action, payload });

export function ClusterUpdates({ local = false }: { local?: boolean }) {
  const cluster = useCluster();
  const visible = useWindowVisible();
  const { user } = useAppContext();
  const queryClient = useQueryClient();
  const servers = (cluster.data?.servers ?? []).filter((server) => (local ? server.local : cluster.merged || server.id === cluster.selectedId));
  const inventories = useQueries({
    queries: servers.map((server) => ({
      queryKey: ['cluster-updates', server.id],
      queryFn: async (): Promise<Inventory> => {
        const [apps, build, releaseResult, status] = await Promise.all([
          read<AppUpdates>(server.id, 'apps'),
          read<Inventory['build']>(server.id, 'build'),
          read<Release | null>(server.id, 'release').then(
            (value) => ({ value, failed: false }),
            () => ({ value: null, failed: true }),
          ),
          read<Status>(server.id, 'update-status').catch(() => null),
        ]);
        return { apps, build, release: releaseResult.value, releaseFailed: releaseResult.failed, status };
      },
      enabled: visible,
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
      retry: false,
    })),
  });
  const [confirmApps, setConfirmApps] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const ready = servers.flatMap((server, index) => {
    const inventory = inventories[index];
    if (!inventory?.data || inventory.isError) return [];
    const data = inventory.data;
    const apps = data.apps.installed.filter(
      ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
    );
    const job = data.status?.job;
    const canPlan = Boolean(
      data.release?.imageManifestUrl &&
        data.release.tag !== data.build.version &&
        data.status?.available &&
        data.status.enrolled &&
        data.status.imageMatches &&
        data.status.coreState === 'running' &&
        data.status.coreHealth === 'healthy' &&
        data.status.currentTag === data.build.version &&
        !['running', 'recovering', 'interrupted'].includes(job?.state ?? ''),
    );
    return [{ server, data, apps, canPlan }];
  });
  const appCount = ready.reduce((total, entry) => total + entry.apps.length, 0);
  const ordered = <T extends { server: ClusterServer }>(items: T[]) =>
    [...items].sort((left, right) => Number(left.server.local) - Number(right.server.local));
  const runApps = useMutation({
    mutationFn: async () => {
      setConfirmApps(false);
      setOutcomes([]);
      for (const entry of ordered(ready.filter((item) => item.apps.length))) {
        try {
          const result = await command<{ queued: number; failed: number }>(entry.server.id, 'update-apps');
          setOutcomes((current) => [
            ...current,
            {
              server: entry.server.name,
              message: `${result.queued} app update${result.queued === 1 ? '' : 's'} queued.${result.failed ? ` ${result.failed} could not be queued.` : ''} Track completion on this server.`,
              failed: result.failed > 0,
            },
          ]);
        } catch (error) {
          setOutcomes((current) => [
            ...current,
            { server: entry.server.name, message: error instanceof Error ? error.message : 'Update request failed.', failed: true },
          ]);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['cluster-updates'] });
    },
  });
  const runOrbis = useMutation({
    mutationFn: async () => {
      setOutcomes([]);
      let failed = false;
      for (const entry of ordered(ready.filter((item) => item.canPlan))) {
        if (entry.server.local && failed) {
          setOutcomes((current) => [
            ...current,
            { server: entry.server.name, message: 'Admin update skipped so you can resolve member failures first.', failed: true },
          ]);
          continue;
        }
        try {
          const plan = await command<Plan>(entry.server.id, 'plan-orbis', { tag: entry.data.release?.tag });
          await command(entry.server.id, 'apply-orbis', { planId: plan.planId });
          setOutcomes((current) => [
            ...current,
            { server: entry.server.name, message: 'Orbis update started. Follow its status below.', failed: false },
          ]);
        } catch (error) {
          failed = true;
          setOutcomes((current) => [
            ...current,
            {
              server: entry.server.name,
              message: `${error instanceof Error ? error.message : 'No acknowledgement.'} Check the update status before retrying.`,
              failed: true,
            },
          ]);
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['cluster-updates'] });
    },
    retry: false,
  });
  const busy = runApps.isPending || runOrbis.isPending;
  const operator = user.operator && cluster.data?.role !== 'member';
  return (
    <div className="cluster-updates">
      <header className="cluster-updates-heading">
        <div>
          <h2>{local ? 'Updates' : cluster.merged ? cluster.data?.name : cluster.selectedServer?.name}</h2>
        </div>
        <Link to="/settings?tab=cluster">Manage cluster</Link>
      </header>
      {inventories.some((query) => query.isPending) ? <output>Checking servers…</output> : null}
      {servers.map((server, index) =>
        inventories[index]?.isError ? (
          <p className="workspace-message" role="alert" key={server.id}>
            {server.name} is unavailable.{' '}
            <button type="button" onClick={() => void inventories[index]?.refetch()}>
              Retry
            </button>
          </p>
        ) : null,
      )}
      {outcomes.length ? (
        <ul className="cluster-update-outcomes" aria-live="polite">
          {outcomes.map((result) => (
            <li key={result.server} data-failed={result.failed}>
              <strong>{result.server}</strong>
              <span>{result.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <section className="cluster-update-section" aria-labelledby="cluster-app-update-heading">
        <header>
          <div>
            <h3 id="cluster-app-update-heading">App updates</h3>
            <p>
              {appCount} available · {ready.length} server{ready.length === 1 ? '' : 's'}
            </p>
          </div>
          <Button disabled={!operator || busy || !appCount} onClick={() => setConfirmApps(true)}>
            {runApps.isPending ? 'Queuing updates…' : 'Update all apps'}
          </Button>
        </header>
        {!appCount && ready.length && !inventories.some((query) => query.isPending) ? <p>No app updates available.</p> : null}
        {ready
          .filter(({ apps }) => apps.length > 0)
          .map(({ server, apps }) => (
            <div className="cluster-update-server" key={server.id}>
              <h4>{server.name}</h4>
              <ul>
                {apps.map(({ info }) => (
                  <li key={info.urn}>{info.name}</li>
                ))}
              </ul>
            </div>
          ))}
      </section>
      <section className="cluster-update-section" aria-labelledby="cluster-orbis-update-heading">
        <header>
          <div>
            <h3 id="cluster-orbis-update-heading">Orbis updates</h3>
          </div>
          <Button disabled={!operator || busy || !ready.some((entry) => entry.canPlan)} onClick={() => runOrbis.mutate()}>
            {runOrbis.isPending ? 'Updating…' : 'Update all Orbis'}
          </Button>
        </header>
        {ready.map(({ server, data, canPlan }) => (
          <div className="cluster-update-server" key={server.id}>
            <h4>
              {server.name}
              {server.role === 'admin' ? ' · Admin' : ''}
            </h4>
            <p>
              Installed {data.build.version}
              {data.release && data.release.tag !== data.build.version ? ` · Available ${data.release.tag}` : ''}
            </p>
            {data.status?.job ? (
              <output>
                {data.status.job.state === 'complete' ? 'Last update' : 'Update'} · {data.status.job.state}
                {data.status.job.message && data.status.job.state !== 'complete' ? ` · ${data.status.job.message}` : ''}
              </output>
            ) : null}
            {canPlan ? null : (
              <p>
                {data.status?.reason ||
                  (data.release?.tag === data.build.version
                    ? 'Up to date.'
                    : 'Host service enrollment and a healthy matching installation are required.')}
              </p>
            )}
            {data.release ? (
              <section className="cluster-release-changelog" aria-label="Changelog">
                <h5>Changelog</h5>
                <Markdown className="cluster-update-notes" content={data.release.body.trimStart().replace(/^#\s+Orbis[^\n]*\r?\n(?:\r?\n)*/i, '')} />
                <a href={data.release.url} target="_blank" rel="noopener noreferrer">
                  View release on GitHub
                </a>
              </section>
            ) : (
              <p>{data.releaseFailed ? 'Release check unavailable. App updates can still be queued.' : 'No published release found.'}</p>
            )}
          </div>
        ))}
      </section>
      <Dialog open={confirmApps} onOpenChange={setConfirmApps}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Update all apps?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Queue available app updates on{' '}
            {ready
              .filter((entry) => entry.apps.length)
              .map((entry) => entry.server.name)
              .join(', ')}
            . Running apps may restart. Unreachable servers will be skipped.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmApps(false)}>
              Cancel
            </Button>
            <Button onClick={() => runApps.mutate()}>Update all apps</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

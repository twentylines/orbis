import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import {
  clusterSyncKey,
  readClusterSync,
  runClusterSync,
  saveClusterSync,
  saveReceiving,
  syncCategoryKeys,
  syncCategoryNames,
  ClusterSyncError,
  type ClusterSyncHost,
  type ClusterSyncSnapshot,
  type SyncCategory,
} from './cluster-sync-api';
import './cluster-sync-settings.css';

const explanations: Record<SyncCategory, string> = {
  customisation: 'Colour, display and dock appearance. Private wallpapers, app pins and window layouts stay local.',
  'orbis-updates': 'Orbis auto-update policy, including when idle. Daily timing stays local unless selected below.',
  'app-updates': 'Enable or disable updates for matching installed store apps. Existing enabled schedules stay local.',
  schedules: 'Daily update time and matching app timings. Each server keeps its timezone; disabled apps stay disabled.',
};
const statusLabels = {
  idle: 'Changes waiting to sync',
  synced: 'Selected settings synced',
  conflict: 'Local changes need review',
  partial: 'Some categories need review',
  unavailable: 'Server could not confirm sync',
  disabled: 'Sync disabled',
};
const resultLabels = {
  applied: 'Applied',
  unchanged: 'Unchanged',
  conflict: 'Changed locally · review before retrying',
  refused: 'Receiving is not enabled',
  failed: 'Could not apply · retry after review',
  unsupported: 'Unsupported local settings · review or update this host',
};
type Run = (work: (signal: AbortSignal) => Promise<unknown>, success: string) => Promise<void>;

function Categories({
  selected,
  onChange,
  disabled,
  accepted,
  id,
}: {
  selected: SyncCategory[];
  onChange: (next: SyncCategory[]) => void;
  disabled: boolean;
  accepted?: SyncCategory[];
  id: string;
}) {
  return (
    <div className="cluster-sync-categories">
      {syncCategoryKeys.map((category) => (
        <Checkbox
          key={category}
          id={`${id}-${category}`}
          className="cluster-sync-check"
          checked={selected.includes(category)}
          disabled={disabled || (accepted !== undefined && !accepted.includes(category))}
          onCheckedChange={(checked) => onChange(checked ? [...selected, category] : selected.filter((item) => item !== category))}
          label={
            <>
              <strong>{syncCategoryNames[category]}</strong>
              <small>
                {accepted !== undefined && !accepted.includes(category)
                  ? 'Enable receiving for this category on the other server first.'
                  : explanations[category]}
              </small>
            </>
          }
        />
      ))}
    </div>
  );
}
function Receiving({ value, busy, run }: { value: ClusterSyncSnapshot['receiving']; busy: boolean; run: Run }) {
  const id = useId();
  const [selected, setSelected] = useState(value.categories);
  return (
    <form
      className="cluster-sync-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run((signal) => saveReceiving(value.revision, selected, signal), 'Receiving choices saved for this server and your local account.');
      }}
    >
      <p>
        Choose what this paired server may receive. Customisation is applied only to your account here; accounts and security settings stay local.
      </p>
      {value.configured && !value.usesYourAccount ? (
        <p className="cluster-sync-warning">
          Current receiving choices use another local operator account. Saving binds customisation to your account.
        </p>
      ) : null}
      <Categories id={id} selected={selected} onChange={setSelected} disabled={busy} />
      <div className="cluster-sync-actions">
        <Button type="submit" intent="primary" disabled={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
export function ClusterSyncHostChoices({ host, busy, run }: { host: ClusterSyncHost; busy: boolean; run: Run }) {
  const id = useId();
  const [enabled, setEnabled] = useState(Boolean(host.plan?.categories.length));
  const [selected, setSelected] = useState<SyncCategory[]>(host.plan?.categories ?? []);
  const [automatic, setAutomatic] = useState(host.plan?.automatic ?? false);
  const actual = enabled ? selected : [];
  const dirty =
    JSON.stringify([...actual].sort()) !== JSON.stringify([...(host.plan?.categories ?? [])].sort()) ||
    (enabled && automatic) !== (host.plan?.automatic ?? false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void run(
      (signal) => saveClusterSync(host, actual, enabled && automatic, signal),
      actual.length ? 'Sync choices saved. Use Sync now, or keep selected settings in sync.' : 'Settings sync disabled for this server.',
    );
  };
  return (
    <article className="cluster-sync-host">
      <div className="cluster-sync-host-heading">
        <h3>{host.name}</h3>
        <span>{host.available ? (host.plan ? statusLabels[host.plan.status] : 'Choose settings to sync') : 'Unavailable · check connection'}</span>
      </div>
      {host.plan && !host.plan.trustCurrent ? (
        <p className="cluster-sync-warning">Pairing changed. Enable receiving on this server again, then save new sync choices.</p>
      ) : null}
      {host.plan && !host.plan.usesYourAccount ? <p>These choices use another admin account’s customisation. Save to use your account.</p> : null}
      <form className="cluster-sync-form" onSubmit={submit}>
        <Checkbox
          id={`${id}-enabled`}
          className="cluster-sync-check"
          checked={enabled}
          disabled={busy}
          onCheckedChange={setEnabled}
          label={<strong>Sync to this server</strong>}
        />
        {enabled ? (
          <>
            <Categories id={id} selected={selected} onChange={setSelected} disabled={busy} accepted={host.accepted} />
            <Checkbox
              id={`${id}-automatic`}
              className="cluster-sync-check"
              checked={automatic}
              disabled={busy || !host.available}
              onCheckedChange={setAutomatic}
              label={
                <>
                  <strong>Keep selected settings in sync</strong>
                  <small>Checks each minute. Local changes stop that category until you review and sync again.</small>
                </>
              }
            />
          </>
        ) : null}
        <div className="cluster-sync-actions">
          <Button type="submit" intent="primary" disabled={busy || (enabled && !selected.length)}>
            Save
          </Button>
          {host.plan?.categories.length ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || dirty || !enabled || !host.available || !host.plan.usesYourAccount || !host.plan.trustCurrent}
              onClick={() => {
                void run(async (signal) => {
                  const result = await runClusterSync(host, signal);
                  if (result.status !== 'synced')
                    throw new Error(
                      result.status === 'unavailable'
                        ? 'This server did not confirm sync. Check its connection, then refresh and retry.'
                        : 'Some categories were not synced. Refresh, review local changes or receiving choices, then retry.',
                    );
                }, 'Selected settings synced. Each server keeps its own identity and data.');
              }}
            >
              Sync now
            </Button>
          ) : null}
        </div>
      </form>
      {host.plan?.lastAttemptAt ? <p>Last checked {new Date(host.plan.lastAttemptAt).toLocaleString()}</p> : null}
      {host.plan?.results.length ? (
        <ul className="cluster-sync-results">
          {host.plan.results.map((result) => (
            <li key={result.category}>
              <strong>{syncCategoryNames[result.category]}</strong>
              <span>
                {resultLabels[result.status]}
                {result.skippedApps ? ` · ${result.skippedApps} unmatched app${result.skippedApps === 1 ? '' : 's'} skipped` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}
export function ClusterSyncSettings() {
  const { user } = useAppContext();
  const visible = useWindowVisible();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false);
  const mounted = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const status = useQuery({
    queryKey: clusterSyncKey(user?.id),
    queryFn: ({ signal }) => readClusterSync(signal),
    enabled: visible && user?.operator === true,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: (query) =>
      visible && !(query.state.error instanceof ClusterSyncError && [401, 403, 404].includes(query.state.error.status)) ? 15_000 : false,
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  const run: Run = async (work, success) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await work(controller.signal);
      if (mounted.current) setNotice(success);
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : 'Settings sync did not finish. Refresh before retrying.');
    } finally {
      running.current = false;
      abort.current = null;
      if (mounted.current) {
        setBusy(false);
        void status.refetch();
      }
    }
  };
  if (user?.operator !== true) return null;
  return (
    <section className="cluster-settings-section cluster-sync-settings" aria-labelledby="cluster-sync-heading">
      <div>
        <h2 id="cluster-sync-heading">Settings sync</h2>
        <p>
          {status.data?.role === 'member'
            ? 'Receive selected settings from your primary admin.'
            : 'Choose settings and paired hosts from this primary dashboard. Pairing never enables sync automatically.'}
        </p>
      </div>
      <div className="cluster-sync-content">
        <div className="cluster-sync-actions">
          <Button
            type="button"
            variant="outline"
            disabled={busy || status.isFetching}
            onClick={() => {
              void status.refetch();
            }}
          >
            Refresh sync status
          </Button>
        </div>
        {status.isPending ? <output>Reading settings sync…</output> : null}
        {status.isError || error ? (
          <p className="cluster-sync-warning" role="alert">
            {error || status.error?.message}
          </p>
        ) : null}
        {notice ? <output aria-live="polite">{notice}</output> : null}
        {status.data?.role === 'member' ? (
          <Receiving key={status.data.receiving.revision} value={status.data.receiving} busy={busy || status.isError} run={run} />
        ) : null}
        {status.data?.role === 'admin' ? (
          <>
            {status.data.source ? (
              <p>
                Source: Orbis updates{' '}
                {status.data.source.orbis.enabled ? (status.data.source.orbis.mode === 'idle' ? 'when idle' : 'scheduled') : 'off'} ·{' '}
                {status.data.source.appCount} installed store apps · daily time {status.data.source.time}. Hostnames, addresses, accounts, app data
                and security settings stay local.
              </p>
            ) : null}
            {status.data.hosts.length ? null : <p>Pair a server first. Then enable receiving categories on it before choosing settings here.</p>}
            {status.data.hosts.map((host) => (
              <ClusterSyncHostChoices key={`${host.id}:${host.plan?.revision ?? 0}`} host={host} busy={busy || status.isError} run={run} />
            ))}
          </>
        ) : null}
        {status.data?.role === 'standalone' ? (
          <p>Create or join a cluster first. Every category starts off and requires an explicit choice.</p>
        ) : null}
      </div>
    </section>
  );
}

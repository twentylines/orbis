import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useAutosavedToggle } from '../hooks/use-autosaved-toggle';
import {
  clusterSyncKey,
  readClusterSync,
  runClusterSync,
  saveClusterAutomatic,
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
  'orbis-updates': 'Orbis auto-update policy, including when idle. Orbis timing stays local.',
  'app-updates': 'Enable or disable updates for matching installed store apps. Existing enabled schedules stay local.',
  schedules: 'Daily app update time and matching app schedules. Orbis and system timings stay local; disabled apps stay disabled.',
};
const statusLabels = {
  idle: 'Changes waiting to sync',
  synced: '',
  conflict: 'Local changes need review',
  partial: 'Some categories need review',
  unavailable: 'Server could not confirm sync',
  disabled: 'Sync disabled',
};
const resultLabels = {
  applied: '',
  unchanged: '',
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
          Current receiving choices use another local operator account. Confirming receiving binds customisation to your account.
        </p>
      ) : null}
      <Categories id={id} selected={selected} onChange={setSelected} disabled={busy} />
      <div className="cluster-sync-actions">
        <Button type="submit" intent="primary" disabled={busy}>
          Confirm receiving
        </Button>
      </div>
    </form>
  );
}
export function ClusterSyncHostChoices({ host, busy, run }: { host: ClusterSyncHost; busy: boolean; run: Run }) {
  const id = useId();
  const { user } = useAppContext();
  const client = useQueryClient();
  const queryKey = clusterSyncKey(user.id);
  const visible = useWindowVisible();
  const reviewed = Boolean(host.plan?.usesYourAccount && host.plan.trustCurrent && host.plan.categories.length);
  const autoSync = useAutosavedToggle({
    id: `cluster-automatic:${host.id}`,
    scope: `cluster-sync-plan:${host.id}`,
    saved: host.plan?.automatic ?? false,
    disabled: !reviewed || busy || !visible,
    canSet: (checked) => !checked || host.available,
    save: async (checked, signal) => {
      const latest = client.getQueryData<ClusterSyncSnapshot>(queryKey)?.hosts.find((entry) => entry.id === host.id);
      if (!latest) throw new Error('Refresh status and review this host before trying again.');
      try {
        const saved = await saveClusterAutomatic(latest, checked, signal);
        await client.cancelQueries({ queryKey, exact: true });
        signal.throwIfAborted();
        client.setQueryData<ClusterSyncSnapshot>(
          queryKey,
          (current) =>
            current && {
              ...current,
              hosts: current.hosts.map((entry) =>
                entry.id === host.id && entry.plan?.revision === latest.plan?.revision && entry.plan
                  ? { ...entry, plan: { ...entry.plan, automatic: saved.automatic, revision: saved.revision } }
                  : entry,
              ),
            },
        );
      } catch (error) {
        if (!signal.aborted) void client.invalidateQueries({ queryKey });
        throw error;
      }
    },
  });
  const [enabled, setEnabled] = useState(Boolean(host.plan?.categories.length));
  const [selected, setSelected] = useState<SyncCategory[]>(host.plan?.categories ?? []);
  const [automaticDraft, setAutomaticDraft] = useState(host.plan?.automatic ?? false);
  const automatic = reviewed ? (host.plan?.automatic ?? false) : automaticDraft;
  const actual = enabled ? selected : [];
  const dirty =
    JSON.stringify([...actual].sort()) !== JSON.stringify([...(host.plan?.categories ?? [])].sort()) ||
    (enabled && automatic) !== (host.plan?.automatic ?? false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (autoSync.pending) return;
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
        <p className="cluster-sync-warning">Pairing changed. Enable receiving on this server again, then confirm the new sync choices.</p>
      ) : null}
      {host.plan && !host.plan.usesYourAccount ? (
        <p>These choices use another admin account’s customisation. Confirm the sync choices to use your account.</p>
      ) : null}
      <form className="cluster-sync-form" onSubmit={submit}>
        <Checkbox
          id={`${id}-enabled`}
          className="cluster-sync-check"
          checked={enabled}
          disabled={busy || autoSync.pending}
          onCheckedChange={setEnabled}
          label={<strong>Sync to this server</strong>}
        />
        {enabled ? (
          <>
            <Categories id={id} selected={selected} onChange={setSelected} disabled={busy || autoSync.pending} accepted={host.accepted} />
            <Checkbox
              id={`${id}-automatic`}
              className="cluster-sync-check"
              checked={reviewed ? autoSync.checked : automaticDraft}
              disabled={reviewed ? autoSync.disabled || autoSync.pending : busy || !host.available}
              aria-busy={autoSync.pending || undefined}
              onCheckedChange={reviewed ? autoSync.setChecked : setAutomaticDraft}
              label={
                <>
                  <strong>Keep selected settings in sync</strong>
                  <small>Checks each minute. Local changes stop that category until you review and sync again.</small>
                </>
              }
            />
            {autoSync.pending || autoSync.saved ? <output>{autoSync.pending ? 'Saving…' : 'Saved'}</output> : null}
            {autoSync.error ? (
              <p className="cluster-sync-warning" role="alert">
                {autoSync.error}{' '}
                {autoSync.retry ? (
                  <Button type="button" variant="outline" onClick={autoSync.retry}>
                    Try again
                  </Button>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
        <div className="cluster-sync-actions">
          <Button type="submit" intent="primary" disabled={busy || autoSync.pending || (enabled && !selected.length)}>
            Confirm sync choices
          </Button>
          {host.plan?.categories.length ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || autoSync.pending || dirty || !enabled || !host.available || !host.plan.usesYourAccount || !host.plan.trustCurrent}
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
      {host.plan?.results.some((result) => !['applied', 'unchanged'].includes(result.status) || Boolean(result.skippedApps)) ? (
        <ul className="cluster-sync-results">
          {host.plan.results
            .filter((result) => !['applied', 'unchanged'].includes(result.status) || Boolean(result.skippedApps))
            .map((result) => (
              <li key={result.category}>
                <strong>{syncCategoryNames[result.category]}</strong>
                <span>
                  {resultLabels[result.status]}
                  {result.skippedApps
                    ? `${resultLabels[result.status] ? ' · ' : ''}${result.skippedApps} unmatched app${result.skippedApps === 1 ? '' : 's'} skipped`
                    : ''}
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
  const run: Run = async (work) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    abort.current = controller;
    try {
      await work(controller.signal);
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
              <ClusterSyncHostChoices
                key={JSON.stringify([host.id, host.plan?.categories, host.plan?.usesYourAccount, host.plan?.trustCurrent])}
                host={host}
                busy={busy || status.isError}
                run={run}
              />
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

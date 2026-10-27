import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import * as Accordion from '@radix-ui/react-accordion';
import { IconCheck, IconChevronRight, IconDatabase, IconRefresh, IconAlertTriangle } from '@tabler/icons-react';
import type { DriveHealth, DriveHealthSample, DriveHealthState } from '@runtipi/common/schemas/drive-health';
import { useWindowVisible } from '@/desktop/window-visibility';
import { useServerPath } from '@/desktop/cluster-data';
import { useOptionalCluster } from '@/desktop/cluster';
import { driveSelfTestIssue, requestDriveSelfTest } from '@/desktop/drive-self-test';
import { useReducedMotion } from '@/desktop/motion-preferences';
import { useAppContext } from '@/context/app-context';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { resourceBytes } from '@/components/container-resources/container-resources';
import './drive-health.css';

const labels: Record<DriveHealthState, string> = {
  passed: 'Passed',
  warning: 'Needs attention',
  failed: 'Failing',
  unavailable: 'Unavailable',
  sleeping: 'Sleeping',
};
const reading = (value: number | null, unit = '') => (value === null ? 'Not reported' : `${value.toLocaleString()}${unit}`);
const temperature = (value: number | null) => reading(value, ' °C');

function DriveTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: This bounded table region needs native keyboard scrolling.
    <section className="drive-health-table-scroll" tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}

function DriveTestLog({ tests }: { tests: DriveHealth['tests'] }) {
  return (
    <ul className="drive-health-test-log drive-health-self-test-log">
      {tests.map((entry, index) => (
        <li key={`${entry.type}-${entry.hours}-${index}`}>
          <span className="drive-health-test-copy">
            <span>{entry.type}</span>
            <strong data-failed={entry.passed === false}>{entry.status}</strong>
          </span>
          <span className="drive-health-test-age">
            <span>Power-on time</span>
            <span>{reading(entry.hours, ' h')}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function DriveHealthView() {
  const visible = useWindowVisible();
  const serverPath = useServerPath();
  const server = useOptionalCluster()?.selectedServer;
  const path = serverPath('/api/system/drives');
  const { user } = useAppContext();
  const client = useQueryClient();
  const reduced = useReducedMotion();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [attention, setAttention] = useState(false);
  const [confirmation, setConfirmation] = useState<{ drive: DriveHealth; kind: 'short' | 'extended' | 'abort' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const query = useQuery<DriveHealthSample>({
    queryKey: ['drive-health', path],
    queryFn: async ({ signal }) => {
      const response = await fetch(path, { credentials: 'include', signal });
      if (!response.ok) throw new Error('Drive health could not be loaded.');
      return response.json();
    },
    enabled: visible,
    refetchInterval: (query) =>
      query.state.data?.available ? 30_000 : query.state.data?.reason === 'Collecting drive health readings.' ? 5000 : 60_000,
    refetchIntervalInBackground: false,
  });
  const test = useMutation({
    mutationFn: ({ drive, kind }: NonNullable<typeof confirmation>) =>
      requestDriveSelfTest({ id: drive.id, kind, serverId: server && !server.local ? server.id : null }),
    onSuccess: (message) => {
      setNotice(message);
      setConfirmation(null);
      void client.invalidateQueries({ queryKey: ['drive-health', path] });
    },
  });
  useLayoutEffect(() => {
    if (!test.isError) return;
    const action = retry.current;
    const target = action?.disabled ? action.closest('[role="dialog"]')?.querySelector<HTMLButtonElement>('button:not(:disabled)') : action;
    target?.focus();
  }, [test.isError]);
  const data = query.data?.available ? query.data : null;
  const delayed = !data || data.stale || query.isError;
  const confirmedDrive = data?.drives.find((drive) => drive.id === confirmation?.drive.id);
  const confirmationIssue = driveSelfTestIssue(confirmation?.kind, confirmedDrive, delayed);
  const needingAttention = data?.drives.filter((drive) => drive.health === 'warning' || drive.health === 'failed') ?? [];
  const drives =
    data?.drives.filter(
      (drive) => (!attention || needingAttention.includes(drive)) && `${drive.model} ${drive.device}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const active = drives.find((drive) => drive.id === selected) ?? drives[0];
  const requestTest = (drive: DriveHealth, kind: 'short' | 'extended' | 'abort') => {
    test.reset();
    setConfirmation({ drive, kind });
  };
  return (
    <section className="drive-health" aria-labelledby="drive-health-title" tabIndex={-1} data-dialog-focus-fallback>
      <header className="drive-health-heading">
        <div>
          <h2 id="drive-health-title">
            <IconDatabase size={22} aria-hidden="true" />
            Drive health
          </h2>
          <p>Physical disks · SMART and NVMe</p>
        </div>
        <button type="button" className="btn" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <IconRefresh size={18} aria-hidden="true" />
          Refresh
        </button>
      </header>
      {query.isPending ? <output>Reading drive health…</output> : null}
      {query.isError ? (
        <p role="alert" className="workspace-message">
          Drive health could not be loaded. Try refreshing.
        </p>
      ) : null}
      {query.data?.available === false ? <output className="workspace-message">{query.data.reason}</output> : null}
      {data ? (
        <>
          <div className="drive-health-toolbar">
            <fieldset className="drive-health-filter">
              <legend className="visually-hidden">Show drives</legend>
              <button type="button" aria-pressed={!attention} onClick={() => setAttention(false)}>
                All drives <span>{data.drives.length}</span>
              </button>
              <button type="button" aria-pressed={attention} onClick={() => setAttention(true)}>
                Needs attention <span>{needingAttention.length}</span>
              </button>
            </fieldset>
            <input
              type="search"
              className="form-control"
              aria-label="Find a drive"
              placeholder="Find a drive"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <p className="drive-health-sampling">
            {delayed ? 'Readings delayed · last sample ' : 'Last checked '}
            {new Date(data.sampledAt).toLocaleTimeString()}. Checks respect standby when the device supports power detection.
          </p>
          {data.limited ? (
            <p className="workspace-message">
              Some devices could not be scanned. RAID controllers and USB bridges may require additional host support.
            </p>
          ) : null}
          {data.historyAvailable ? null : <p className="workspace-message">Drive history could not be saved. Current readings remain available.</p>}
          {drives.length ? (
            <div className="drive-health-layout">
              <section className="drive-health-list" aria-label="Physical drives">
                {drives.map((drive) => (
                  <button
                    type="button"
                    key={drive.id}
                    className="drive-health-device"
                    aria-pressed={active?.id === drive.id}
                    onClick={() => setSelected(drive.id)}
                  >
                    <IconDatabase size={24} aria-hidden="true" />
                    <span className="drive-health-device-copy">
                      <strong title={drive.model}>{drive.model}</strong>
                      <span className="drive-health-device-identity">
                        <span className="drive-health-device-path" title={drive.device}>
                          {drive.device}
                        </span>
                        <span>{drive.capacityBytes === null ? 'Capacity unavailable' : resourceBytes(drive.capacityBytes)}</span>
                      </span>
                      <span className="drive-health-device-values">
                        <span className="drive-health-state" data-health={drive.health}>
                          {drive.health === 'passed' ? (
                            <IconCheck size={14} aria-hidden="true" />
                          ) : drive.health === 'failed' || drive.health === 'warning' ? (
                            <IconAlertTriangle size={14} aria-hidden="true" />
                          ) : null}
                          {labels[drive.health]}
                        </span>
                        {drive.temperature === null ? null : <span>{temperature(drive.temperature)}</span>}
                      </span>
                    </span>
                    <IconChevronRight size={18} aria-hidden="true" />
                  </button>
                ))}
              </section>
              <AnimatePresence mode="wait" initial={false}>
                {active ? (
                  <motion.article
                    key={active.id}
                    className="drive-health-detail"
                    initial={{ opacity: 0, y: reduced ? 0 : 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduced ? 0 : 0.16 }}
                    aria-label={`${active.model} health details`}
                  >
                    <header>
                      <div>
                        <h3>{active.model}</h3>
                        <p>
                          {active.protocol} · {active.device}
                          {active.firmware ? ` · Firmware ${active.firmware}` : ''}
                        </p>
                      </div>
                      <span className="drive-health-state" data-health={active.health}>
                        {labels[active.health]}
                      </span>
                    </header>
                    {active.reasons.length ? (
                      <ul className="drive-health-reasons">
                        {active.reasons.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    ) : active.health === 'passed' ? (
                      <p className="drive-health-passed">
                        {delayed ? 'The last successful reading reported no SMART warnings.' : 'No SMART warnings reported.'} A passed check does not
                        guarantee a drive will not fail.
                      </p>
                    ) : (
                      <p className="drive-health-passed">
                        {active.health === 'sleeping'
                          ? 'This drive is sleeping. Automatic checks leave it asleep; current SMART health is not available.'
                          : active.health === 'unavailable'
                            ? 'Current SMART health could not be read from this device.'
                            : active.health === 'failed'
                              ? 'The drive reports a failing SMART health check. Back up important data.'
                              : 'The drive reported a health warning without further details.'}
                      </p>
                    )}
                    <dl className="drive-health-metrics">
                      {[
                        ['Temperature', temperature(active.temperature)],
                        ['Endurance used', reading(active.percentageUsed, '%')],
                        ['Power-on time', reading(active.powerOnHours, ' h')],
                        ['Spare capacity', reading(active.availableSpare, '%')],
                        ['Reallocated sectors', reading(active.reallocatedSectors)],
                        ['Pending sectors', reading(active.pendingSectors)],
                        ['Uncorrectable sectors', reading(active.uncorrectableSectors)],
                        ['Media errors', reading(active.mediaErrors)],
                      ]
                        .filter(([label, value]) => label === 'Temperature' || value !== 'Not reported')
                        .map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                    </dl>
                    <section className="drive-health-tests" aria-label="Drive self-tests">
                      <h4>Self-tests</h4>
                      <p>
                        {active.selfTest.running
                          ? `A test is running${active.selfTest.remainingPercent === null ? '.' : ` · ${active.selfTest.remainingPercent}% remaining.`}`
                          : active.selfTest.supported
                            ? 'Run a device-supported test without taking the disk offline.'
                            : 'Self-tests are not available through this device or host connection.'}
                      </p>
                      {active.selfTest.supported && user?.operator ? (
                        <div className="drive-health-actions">
                          {active.selfTest.running ? (
                            <button className="btn" type="button" onClick={() => requestTest(active, 'abort')}>
                              Stop test
                            </button>
                          ) : (
                            <>
                              <button className="btn" type="button" disabled={delayed} onClick={() => requestTest(active, 'short')}>
                                Short test{active.selfTest.shortMinutes ? ` · ~${active.selfTest.shortMinutes} min` : ''}
                              </button>
                              <button className="btn" type="button" disabled={delayed} onClick={() => requestTest(active, 'extended')}>
                                Extended test{active.selfTest.extendedMinutes ? ` · ~${active.selfTest.extendedMinutes} min` : ''}
                              </button>
                            </>
                          )}
                        </div>
                      ) : active.selfTest.supported ? (
                        <p>An operator account is required to run a self-test.</p>
                      ) : null}
                      {delayed && !active.selfTest.running && active.selfTest.supported && user?.operator ? (
                        <p>Refresh drive health successfully before starting a self-test.</p>
                      ) : null}
                      {active.tests.length ? (
                        <>
                          <h5 className="drive-health-latest-test">Latest result</h5>
                          <DriveTestLog tests={active.tests.slice(0, 1)} />
                          {active.tests.length > 1 ? (
                            <Accordion.Root type="single" collapsible className="drive-health-test-history" data-reduced-motion={reduced}>
                              <Accordion.Item value="history">
                                <Accordion.Header className="drive-health-test-history-heading" asChild>
                                  <h5>
                                    <Accordion.Trigger className="drive-health-test-history-toggle">
                                      <span>Earlier results · {active.tests.length - 1}</span>
                                      <IconChevronRight size={18} aria-hidden="true" />
                                    </Accordion.Trigger>
                                  </h5>
                                </Accordion.Header>
                                <Accordion.Content className="drive-health-test-history-content">
                                  <DriveTestLog tests={active.tests.slice(1)} />
                                </Accordion.Content>
                              </Accordion.Item>
                            </Accordion.Root>
                          ) : null}
                        </>
                      ) : (
                        <p>No self-test results reported.</p>
                      )}
                    </section>
                    {[active.errorCount, active.unsafeShutdowns, active.bytesRead, active.bytesWritten].some((value) => value !== null) ? (
                      <details className="drive-health-disclosure">
                        <summary>More drive statistics</summary>
                        <dl className="drive-health-metrics">
                          {[
                            ['Error log entries', reading(active.errorCount)],
                            ['Unsafe shutdowns', reading(active.unsafeShutdowns)],
                            ['Data read', active.bytesRead === null ? 'Not reported' : resourceBytes(active.bytesRead)],
                            ['Data written', active.bytesWritten === null ? 'Not reported' : resourceBytes(active.bytesWritten)],
                          ]
                            .filter(([, value]) => value !== 'Not reported')
                            .map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                        </dl>
                      </details>
                    ) : null}
                    <details className="drive-health-disclosure">
                      <summary>Device error log · {active.errorCount === null ? 'count unavailable' : active.errorCount.toLocaleString()}</summary>
                      <p>Entries can describe past command errors. Review them alongside current SMART warnings.</p>
                      {active.errors.length ? (
                        <ul className="drive-health-test-log">
                          {active.errors.map((error, index) => (
                            <li key={`${error.summary}-${index}`}>
                              <span>{error.summary}</span>
                              <span>{reading(error.hours, ' h')}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No detailed error entries reported.</p>
                      )}
                    </details>
                    <details className="drive-health-disclosure">
                      <summary>Health history · last 7 days</summary>
                      <p>
                        Hourly peak values and the most severe health state are retained while Drive health is open. Idle periods have no samples.
                      </p>
                      {active.history.length ? (
                        <DriveTable label="Drive health history">
                          <table>
                            <thead>
                              <tr>
                                <th>Recorded</th>
                                <th>Health</th>
                                <th>Temperature</th>
                                <th>Wear</th>
                                <th>Pending sectors</th>
                                <th>Media errors</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...active.history].reverse().map((point) => (
                                <tr key={point.at}>
                                  <td>{new Date(point.at).toLocaleString()}</td>
                                  <td>{labels[point.health]}</td>
                                  <td>{temperature(point.temperature)}</td>
                                  <td>{reading(point.percentageUsed, '%')}</td>
                                  <td>{reading(point.pendingSectors)}</td>
                                  <td>{reading(point.mediaErrors)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </DriveTable>
                      ) : (
                        <p>No history has been recorded for this drive yet.</p>
                      )}
                    </details>
                    {active.attributes.length ? (
                      <details className="drive-health-disclosure">
                        <summary>SMART attributes · {active.attributes.length}</summary>
                        <p>Names and raw units are supplied by the manufacturer. Raw values are not comparable across models.</p>
                        <DriveTable label="SMART attributes">
                          <table>
                            <thead>
                              <tr>
                                <th>Attribute</th>
                                <th>Value</th>
                                <th>Worst</th>
                                <th>Threshold</th>
                                <th>Raw</th>
                              </tr>
                            </thead>
                            <tbody>
                              {active.attributes.map((attribute) => (
                                <tr key={attribute.id} data-failed={attribute.failing}>
                                  <td>
                                    {attribute.id} · {attribute.name.replaceAll('_', ' ')}
                                  </td>
                                  <td>{reading(attribute.value)}</td>
                                  <td>{reading(attribute.worst)}</td>
                                  <td>{reading(attribute.threshold)}</td>
                                  <td>{attribute.raw}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </DriveTable>
                      </details>
                    ) : null}
                  </motion.article>
                ) : null}
              </AnimatePresence>
            </div>
          ) : (
            <p>{search || attention ? 'No drives match this filter.' : 'No supported physical disks were reported by the host.'}</p>
          )}
        </>
      ) : null}
      {notice ? <output className="drive-health-notice">{notice}</output> : null}
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open && !test.isPending) setConfirmation(null);
        }}
      >
        <DialogContent closeDisabled={test.isPending} size="sm" className="drive-health-confirmation-dialog">
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === 'abort'
                ? 'Stop drive self-test?'
                : `Run ${confirmation?.kind === 'extended' ? 'an extended' : 'a short'} self-test?`}
            </DialogTitle>
          </DialogHeader>
          <DialogDescription>
            <p className="drive-health-confirmation-device">
              <strong>{confirmation?.drive.model}</strong>
              <span>{confirmation?.drive.device}</span>
            </p>
            <p>
              {confirmation?.kind === 'abort'
                ? 'The drive may record this test as aborted. Existing data is kept.'
                : 'The disk stays online. A test can slow disk access and can wake a sleeping drive. Keep a current backup of important data.'}
            </p>
            {test.isError ? (
              <p role="alert" className="drive-health-command-error">
                <IconAlertTriangle size={18} aria-hidden="true" />
                <span>{test.error.message}</span>
              </p>
            ) : null}
            {confirmationIssue ? (
              <p>
                <output>{confirmationIssue}</output>
              </p>
            ) : null}
          </DialogDescription>
          <DialogFooter>
            <button type="button" className="btn" disabled={test.isPending} onClick={() => setConfirmation(null)}>
              Cancel
            </button>
            <button
              ref={retry}
              type="button"
              className="btn btn-primary"
              disabled={test.isPending || !confirmation || Boolean(confirmationIssue)}
              onClick={() => {
                if (confirmation) test.mutate(confirmation);
              }}
            >
              {test.isPending ? 'Sending request…' : confirmation?.kind === 'abort' ? 'Stop test' : 'Start self-test'}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

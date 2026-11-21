import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { IconActivity, IconAlertTriangle, IconArrowLeft, IconCheck, IconFilter, IconSearch, IconX } from '@tabler/icons-react';
import { Link } from 'react-router';
import { DisclosureIndicator } from '@/components/ui/DisclosureIndicator/DisclosureIndicator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import { SourceRestoreRequests } from '@/modules/host-transfer/source-restore-requests';
import type { useRestoreRequests } from '@/modules/host-transfer/receiver-request-context';
import { isSetupFailureTask } from './task-centre-records';
import type { ActivitySourceIssue, SystemActivitySnapshot } from './system-task-activity';
import {
  filterTaskCentreRecords,
  groupTaskCentreAttempts,
  shortTaskTime,
  taskCentreRecords,
  taskDuration,
  type TaskCentreGroup,
  type TaskCentreRecord,
  type TaskCentreView,
} from './task-centre-model';
import { useReducedMotion } from './motion-preferences';
import { activityIsHidden, canDismissActivity, completedActivity } from './task-centre-visibility';
import { useTaskCentreVisibility } from './use-task-centre-visibility';
import './desktop-task-panel.css';

export function taskPanelPosition(anchor: { left: number; right: number; bottom: number }, width: number, viewportWidth: number) {
  return { left: Math.max(16, Math.min((anchor.left + anchor.right - width) / 2, viewportWidth - width - 16)), top: anchor.bottom + 8 };
}

type TaskPanelProps = {
  tasks: TaskRecord[];
  visibilityOwner?: string;
  names?: Map<string, string>;
  dismissSetupFailure?: (id: string) => void;
  restoreRequests?: ReturnType<typeof useRestoreRequests>;
  systemActivity?: SystemActivitySnapshot;
  loading: boolean;
  failed: boolean;
  storageUnavailable: boolean;
  capture?: TimeMachinePoint | null;
  captureFailed: boolean;
  pendingRequests: number;
  criticalUpdate: boolean;
  retry: () => unknown;
  retryCapture?: () => unknown;
  close: () => void;
  surface?: 'panel' | 'page';
  initialSource?: string;
  attentionUnavailable?: boolean;
  retryAttention?: () => unknown;
};

function TaskSymbol({ record }: { record: TaskCentreRecord }) {
  return record.bucket === 'active' ? (
    <IconActivity size={19} />
  ) : record.outcome === 'succeeded' ? (
    <IconCheck size={19} />
  ) : (
    <IconAlertTriangle size={19} />
  );
}
function reportedProgress(record: TaskCentreRecord) {
  const progress = record.progress;
  return !record.stale &&
    progress &&
    Number.isFinite(progress.completed) &&
    progress.completed >= 0 &&
    progress.total != null &&
    Number.isFinite(progress.total) &&
    progress.total > 0 &&
    progress.completed <= progress.total
    ? progress
    : null;
}
function TaskRow({
  record,
  select,
  dismiss,
}: {
  record: TaskCentreGroup;
  select: (key: string) => void;
  dismiss?: (record: TaskCentreGroup, button: HTMLButtonElement) => void;
}) {
  const progress = reportedProgress(record);
  const dismissible = dismiss && record.attempts.every(canDismissActivity);
  return (
    <li className="task-centre-card" data-status={record.outcome} data-dismissible={dismissible || undefined}>
      <button
        type="button"
        className="task-centre-row"
        data-task-key={record.key}
        onClick={() => select(record.key)}
        aria-label={`${record.title}, ${record.status}${record.attempts.length > 1 ? `, ${record.attempts.length} attempts` : ''}`}
      >
        <span className="task-centre-symbol" aria-hidden="true">
          <TaskSymbol record={record} />
        </span>
        <span className="task-centre-row-copy">
          <strong title={record.title}>{record.title}</strong>
          <span className="task-centre-row-meta">
            <span>
              {record.status}
              {record.stale ? ' · last reported' : ''}
              {record.attempts.length > 1 ? ` · ${record.attempts.length} attempts` : ''}
            </span>
            <time dateTime={record.time ? new Date(record.time).toISOString() : undefined}>{shortTaskTime(record.time)}</time>
          </span>
          {record.phase && record.bucket === 'active' ? <small>{record.phase.replaceAll('-', ' ')}</small> : null}
          {progress && record.bucket === 'active' ? (
            <progress aria-label={`${record.title} progress`} value={progress.completed} max={progress.total ?? undefined} />
          ) : null}
        </span>
        <span className="task-centre-row-action" aria-hidden="true">
          {record.bucket === 'review' ? 'Review' : 'Details'}
        </span>
      </button>
      {dismissible ? (
        <button
          type="button"
          className="task-centre-dismiss"
          aria-label={`Dismiss ${record.title} from activity`}
          title="Hide from activity"
          onClick={(event) => dismiss(record, event.currentTarget)}
        >
          <span className="task-centre-dismiss-icon" aria-hidden="true">
            <IconX size={15} />
          </span>
        </button>
      ) : null}
    </li>
  );
}

export function TaskDetails({ record, close, dismiss }: { record: TaskCentreGroup; close: () => void; dismiss?: (id: string) => void }) {
  const setup = record.task && isSetupFailureTask(record.task) ? record.task : null;
  const progress = reportedProgress(record);
  const duration = taskDuration(record);
  const explanation =
    record.message ||
    (record.outcome === 'unconfirmed' || record.outcome === 'interrupted'
      ? 'The outcome has not been confirmed. Check the application or service before trying again.'
      : record.outcome === 'failed'
        ? 'This operation failed. The server did not provide an error message in this record. Open the service or logs for diagnostics.'
        : record.bucket === 'active'
          ? 'This is the latest reported operation state.'
          : 'This is the recorded result. Application health is checked separately.');
  return (
    <article className="task-centre-details">
      <div className="task-centre-detail-status" data-status={record.outcome}>
        <TaskSymbol record={record} />
        <span>
          {record.status}
          {record.stale ? ' · last reported' : ''}
        </span>
      </div>
      <h3 tabIndex={-1} className="task-centre-detail-title">
        {record.title}
      </h3>
      <p>{explanation}</p>
      {record.phase ? (
        <p className="task-centre-stage">
          <strong>Stage</strong> {record.phase.replaceAll('-', ' ')}
        </p>
      ) : null}
      {record.stale ? (
        <p className="task-centre-notice">Current status could not be refreshed. Progress and elapsed time are not being estimated.</p>
      ) : null}
      {progress ? <progress aria-label={`${record.title} progress`} value={progress.completed} max={progress.total ?? undefined} /> : null}
      {record.progress && record.progress.completed > 0 ? (
        <p className="task-centre-detail-bytes">
          {formatBackupBytes(record.progress.completed)}
          {record.progress.total && record.progress.total >= record.progress.completed
            ? ` of ${formatBackupBytes(record.progress.total)}`
            : ' reported'}
        </p>
      ) : null}
      <dl className="task-centre-metadata">
        <div>
          <dt>Application or service</dt>
          <dd>{record.source}</dd>
        </div>
        {record.time ? (
          <div>
            <dt>Reported</dt>
            <dd>
              <time dateTime={new Date(record.time).toISOString()}>{new Date(record.time).toLocaleString()}</time>
            </dd>
          </div>
        ) : null}
        {record.startedAt ? (
          <div>
            <dt>Started</dt>
            <dd>{new Date(record.startedAt).toLocaleString()}</dd>
          </div>
        ) : null}
        {record.finishedAt ? (
          <div>
            <dt>Finished</dt>
            <dd>{new Date(record.finishedAt).toLocaleString()}</dd>
          </div>
        ) : null}
        {duration ? (
          <div>
            <dt>{record.finishedAt ? 'Duration' : 'Elapsed'}</dt>
            <dd>{duration}</dd>
          </div>
        ) : null}
        <div>
          <dt>Record ID</dt>
          <dd>{record.key}</dd>
        </div>
      </dl>
      <div className="task-centre-detail-actions">
        {record.actions.map((action) => (
          <Link key={action.path} to={action.path} onClick={close}>
            {action.label}
          </Link>
        ))}
        {setup && !setup.setupFailureDismissed && dismiss ? (
          <button
            type="button"
            onClick={(event) => {
              const title = event.currentTarget.closest('article')?.querySelector<HTMLElement>('.task-centre-detail-title');
              dismiss(setup.id);
              requestAnimationFrame(() => title?.focus());
            }}
          >
            Dismiss setup notice
          </button>
        ) : null}
      </div>
      {setup?.setupFailureDismissed ? <p>Setup notice dismissed. The failed result remains in history.</p> : null}
      {record.attempts.length > 1 ? (
        <section className="task-centre-attempts" aria-label="Attempt history">
          <h4>{record.attempts.length} attempts</h4>
          <ol>
            {record.attempts.map((attempt) => (
              <li key={attempt.key}>
                <strong>{attempt.status}</strong>
                <time dateTime={attempt.time ? new Date(attempt.time).toISOString() : undefined}>
                  {attempt.time ? new Date(attempt.time).toLocaleString() : 'Time not reported'}
                </time>
                <code>{attempt.key}</code>
                {attempt.message ? <p>{attempt.message}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </article>
  );
}

const activitySlide = { duration: 0.34, ease: [0.22, 1, 0.36, 1] } as const;

function ActivityStage({ children, direction, reduced }: { children: ReactNode; direction: number; reduced: boolean }) {
  const present = useIsPresent();
  return (
    <motion.div
      className="task-centre-stage-view"
      data-present={present}
      aria-hidden={!present || undefined}
      inert={!present}
      custom={direction}
      variants={{
        enter: (next: number) => ({ x: `${next * 100}%` }),
        active: { x: '0%' },
        exit: (next: number) => ({ x: `${-next * 100}%` }),
      }}
      initial={reduced ? false : 'enter'}
      animate="active"
      exit={reduced ? { x: '0%', transition: { duration: 0 } } : 'exit'}
      transition={reduced ? { duration: 0 } : activitySlide}
    >
      {children}
    </motion.div>
  );
}

function ActivityDisclosure({ id, expanded, children }: { id: string; expanded: boolean; children: ReactNode }) {
  return (
    <div id={id} className="task-centre-disclosure" data-expanded={expanded || undefined} aria-hidden={!expanded || undefined} inert={!expanded}>
      <div className="task-centre-disclosure-content">{children}</div>
    </div>
  );
}

function ActivityWarning({
  issues,
  countsIncomplete,
  descriptionId,
  onResolve,
}: {
  issues: ActivitySourceIssue[];
  countsIncomplete: boolean;
  descriptionId: string;
  onResolve: () => void;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const focused = useRef(false);
  const visible = countsIncomplete || issues.length > 0;
  const retries = new Set(issues.flatMap((issue) => (issue.retry ? [issue.retry] : [])));
  useLayoutEffect(() => {
    if (!visible && focused.current) {
      focused.current = false;
      onResolve();
    }
  }, [visible, onResolve]);
  if (!visible) return null;
  return (
    <fieldset
      className="task-centre-warning"
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focused.current = false;
      }}
    >
      <legend className="visually-hidden">Activity availability</legend>
      <div className="task-centre-warning-row">
        <button
          className="task-centre-warning-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
        >
          <IconAlertTriangle size={17} aria-hidden="true" />
          <span id={descriptionId} className="task-centre-warning-copy">
            <strong>Limited activity</strong>
            {countsIncomplete ? <small>Counts are partial.</small> : null}
          </span>
          <DisclosureIndicator size={15} />
        </button>
        {retries.size > 0 ? (
          <button
            className="task-centre-warning-retry"
            type="button"
            aria-busy={retrying || undefined}
            aria-disabled={retrying || undefined}
            aria-label="Retry unavailable activity sources"
            onClick={async () => {
              if (retrying) return;
              setRetrying(true);
              await Promise.allSettled([...retries].map(async (retry) => retry()));
              setRetrying(false);
            }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : null}
      </div>
      <ActivityDisclosure id={detailsId} expanded={expanded}>
        <ul className="task-centre-warning-details">
          {issues.length ? issues.map(({ message }) => <li key={message}>{message}</li>) : <li>Some operation sources could not be read.</li>}
        </ul>
      </ActivityDisclosure>
    </fieldset>
  );
}

const emptyNames = new Map<string, string>();
export function DesktopTaskPanel({
  tasks,
  visibilityOwner,
  names = emptyNames,
  dismissSetupFailure,
  restoreRequests,
  systemActivity,
  loading,
  failed,
  storageUnavailable,
  capture,
  captureFailed,
  pendingRequests,
  criticalUpdate,
  retry,
  retryCapture,
  close,
  surface = 'panel',
  initialSource = 'all',
  attentionUnavailable,
  retryAttention,
}: TaskPanelProps) {
  const filterId = useId();
  const availabilityId = useId();
  const visibility = useTaskCentreVisibility(visibilityOwner);
  const reduced = Boolean(useReducedMotion());
  const [direction, setDirection] = useState(1);
  const [view, setView] = useState<TaskCentreView>('all');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState(initialSource);
  const [outcome, setOutcome] = useState('all');
  const [days, setDays] = useState('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const viewElement = useRef<HTMLDivElement>(null);
  const previousPanelHeight = useRef<number | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const undoFocused = useRef(false);
  const scroll = useRef(0);
  const outgoingScroll = useRef(0);
  const restoreKey = useRef<string | null>(null);
  const revealAfterSlide = useRef<HTMLButtonElement | null>(null);
  const records = useMemo(
    () => taskCentreRecords({ tasks, names, system: systemActivity?.records, capture, captureFailed, requests: restoreRequests?.snapshot }),
    [tasks, names, systemActivity?.records, capture, captureFailed, restoreRequests?.snapshot],
  );
  const visibleRecords = records.filter((record) => !activityIsHidden(record, visibility.state));
  const allGroups = useMemo(() => groupTaskCentreAttempts(records), [records]);
  const filtered = filterTaskCentreRecords(view === 'history' ? records : visibleRecords, { view, query, source, outcome, days });
  const clearable = filtered.some(completedActivity);
  const attentionClearable = filtered.some((record) => record.bucket === 'review' && canDismissActivity(record));
  const rows = groupTaskCentreAttempts(filtered);
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const selectedRecord = selected
    ? allGroups.find((record) => record.key === selected || record.attempts.some((attempt) => attempt.key === selected))
    : undefined;
  const unavailable = failed || storageUnavailable || systemActivity?.incomplete || captureFailed || (restoreRequests && !restoreRequests.available);
  const reading = loading || systemActivity?.loading;
  const issues = [...(systemActivity?.notices ?? [])];
  if (failed) issues.unshift({ message: 'Task history could not be refreshed. Shown records are the last reported state.', retry });
  if (storageUnavailable) issues.push({ message: 'History storage is unavailable. Recent records may be lost on restart.', retry });
  if (restoreRequests && !restoreRequests.available)
    issues.push({ message: 'Server transfer status could not be refreshed.', retry: restoreRequests.error ? restoreRequests.refresh : undefined });
  if (captureFailed)
    issues.push({ message: 'Capture status could not be refreshed. Check Time Machine before starting another capture.', retry: retryCapture });
  if (attentionUnavailable) issues.push({ message: 'Saved task alerts are unavailable.', retry: retryAttention });
  const counts = {
    active: visibleRecords.filter((record) => record.bucket === 'active').length,
    review: visibleRecords.filter((record) => record.bucket === 'review').length,
    history: records.filter((record) => record.bucket !== 'active').length,
  };
  const sources = [...new Map(records.map((record) => [record.sourceKey, record.source])).entries()].sort((left, right) =>
    left[1].localeCompare(right[1]),
  );
  const activeFilters = source !== 'all' || outcome !== 'all' || days !== 'all';
  // biome-ignore lint/correctness/useExhaustiveDependencies: Measure the new height after each stage switch and before paint.
  useLayoutEffect(() => {
    const from = previousPanelHeight.current;
    previousPanelHeight.current = null;
    const panel = viewElement.current?.parentElement;
    if (from === null || reduced || surface !== 'panel' || !panel?.matches('.desktop-task-panel')) return;
    const to = Number.parseFloat(getComputedStyle(panel).height);
    if (!Number.isFinite(to) || Math.abs(from - to) < 0.5) return;
    const animation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: activitySlide.duration * 1000,
      easing: `cubic-bezier(${activitySlide.ease.join(',')})`,
      fill: 'both',
    });
    animation.onfinish = () => animation.cancel();
    return () => animation.cancel();
  }, [selected, reduced, surface]);
  useLayoutEffect(() => {
    if (selected) {
      if (body.current) {
        body.current.scrollTop = 0;
        body.current.style.setProperty('--task-centre-exit-offset', `${-outgoingScroll.current}px`);
      }
      body.current?.querySelector<HTMLElement>('[data-present="true"] .task-centre-detail-title')?.focus({ preventScroll: true });
      return;
    }
    if (!restoreKey.current) return;
    const key = restoreKey.current;
    restoreKey.current = null;
    if (body.current) {
      body.current.scrollTop = scroll.current;
      body.current.style.setProperty('--task-centre-exit-offset', `${body.current.scrollTop - outgoingScroll.current}px`);
    }
    const keyInGroup = latestRows.current.find((record) => record.attempts.some((attempt) => attempt.key === key))?.key ?? key;
    const target = [...(body.current?.querySelectorAll<HTMLButtonElement>('[data-present="true"] [data-task-key]') ?? [])].find(
      (element) => element.dataset.taskKey === keyInGroup,
    );
    (target ?? search.current)?.focus({ preventScroll: true });
    if (reduced) target?.scrollIntoView({ block: 'nearest' });
    else revealAfterSlide.current = target ?? null;
  }, [selected, reduced]);
  useLayoutEffect(() => {
    if (!filtersOpen) return;
    const first = body.current?.querySelector<HTMLButtonElement>('[aria-label="Filter application or service"]');
    first?.focus({ preventScroll: true });
    first?.scrollIntoView({ block: 'nearest' });
  }, [filtersOpen]);
  useLayoutEffect(() => {
    if (visibility.undoAvailable || !undoFocused.current) return;
    undoFocused.current = false;
    search.current?.focus({ preventScroll: true });
  }, [visibility.undoAvailable]);
  const prepareStageSwitch = () => {
    const panel = viewElement.current?.parentElement;
    if (reduced || surface !== 'panel' || !panel?.matches('.desktop-task-panel') || typeof panel.animate !== 'function') return;
    const height = Number.parseFloat(getComputedStyle(panel).height);
    if (Number.isFinite(height)) previousPanelHeight.current = height;
  };
  const select = (key: string) => {
    prepareStageSwitch();
    revealAfterSlide.current = null;
    scroll.current = body.current?.scrollTop ?? 0;
    outgoingScroll.current = scroll.current;
    restoreKey.current = key;
    setDirection(1);
    setSelected(key);
  };
  const back = () => {
    prepareStageSwitch();
    outgoingScroll.current = body.current?.scrollTop ?? 0;
    setDirection(-1);
    setSelected(null);
  };
  const dismissRow = (record: TaskCentreGroup, button: HTMLButtonElement) => {
    const rows = [...(body.current?.querySelectorAll<HTMLButtonElement>('[data-present="true"] [data-task-key]') ?? [])];
    const index = rows.findIndex((row) => row.closest('li')?.contains(button));
    const next = rows[index + 1] ?? rows[index - 1];
    visibility.dismiss(record.attempts);
    requestAnimationFrame(() => {
      const target = next?.isConnected ? next : search.current;
      target?.focus({ preventScroll: true });
      if (target === next) target?.scrollIntoView({ block: 'nearest' });
    });
  };
  const clearActivity = (bucket: 'recent' | 'review') => {
    visibility.clear(filtered, bucket);
    requestAnimationFrame(() => {
      const undo = body.current?.querySelector<HTMLButtonElement>('[data-present="true"] [data-activity-undo]');
      undo?.focus({ preventScroll: true });
      undo?.scrollIntoView({ block: 'nearest' });
    });
  };
  return (
    <div ref={viewElement} className="task-centre-view" data-surface={surface}>
      <header className="task-centre-heading">
        <div>
          <h2>{surface === 'panel' ? 'Task centre' : 'Operations'}</h2>
          <p>Manage operations and activity</p>
        </div>
        <div className="task-centre-header-actions">
          {surface === 'panel' ? (
            <button type="button" className="task-centre-close" aria-label="Close task centre" onClick={close}>
              <IconX size={20} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </header>
      <div ref={body} className="task-centre-scroll" tabIndex={-1}>
        <AnimatePresence
          initial={false}
          custom={direction}
          mode="sync"
          onExitComplete={() => {
            const target = revealAfterSlide.current;
            revealAfterSlide.current = null;
            if (target?.isConnected && document.activeElement === target) target.scrollIntoView({ block: 'nearest' });
          }}
        >
          <ActivityStage key={selected ? 'details' : 'activity'} direction={direction} reduced={reduced}>
            {selected ? (
              <div className="task-centre-back">
                <button type="button" onClick={back}>
                  <IconArrowLeft size={18} aria-hidden="true" />
                  Back to activity
                </button>
              </div>
            ) : (
              <div className="task-centre-search">
                <IconSearch size={18} aria-hidden="true" />
                <input
                  ref={search}
                  data-focus-surface="parent"
                  type="search"
                  aria-label="Search task activity"
                  placeholder="Search activity…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            )}
            {selected ? null : (
              <fieldset className="task-centre-summary" aria-describedby={unavailable || reading || issues.length ? availabilityId : undefined}>
                <legend className="visually-hidden">Available operation records</legend>
                {(
                  [
                    ['active', 'Running'],
                    ['review', 'Needs attention'],
                    ['history', 'History'],
                  ] as const
                ).map(([value, label]) => (
                  <button type="button" key={value} aria-pressed={view === value} onClick={() => setView(view === value ? 'all' : value)}>
                    <strong>{counts[value]}</strong>
                    <span>{label}</span>
                  </button>
                ))}
              </fieldset>
            )}
            {selected ? null : (
              <>
                <ActivityWarning
                  issues={issues}
                  countsIncomplete={Boolean(unavailable || (reading && issues.length))}
                  descriptionId={availabilityId}
                  onResolve={() => search.current?.focus({ preventScroll: true })}
                />
                {reading && !unavailable && !issues.length ? (
                  <output id={availabilityId} className="task-centre-loading">
                    Reading operations. Counts update as sources respond.
                  </output>
                ) : null}
              </>
            )}
            {selected ? null : (
              <>
                <div className="task-centre-filter-bar">
                  <button type="button" aria-pressed={view === 'all'} onClick={() => setView('all')}>
                    All
                  </button>
                  <button
                    type="button"
                    aria-expanded={filtersOpen}
                    aria-controls={filterId}
                    aria-label={activeFilters ? 'Filters, active filters applied' : 'Filters'}
                    data-filtered={activeFilters || undefined}
                    onClick={() => setFiltersOpen(!filtersOpen)}
                  >
                    <IconFilter size={16} aria-hidden="true" />
                    Filters
                    <DisclosureIndicator size={16} />
                  </button>
                </div>
                <ActivityDisclosure id={filterId} expanded={filtersOpen}>
                  <div className="task-centre-filters">
                    <div>
                      <Select value={source} onValueChange={setSource}>
                        <SelectTrigger label="Application or service" aria-label="Filter application or service">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All applications and services</SelectItem>
                          {sources.map(([key, name]) => (
                            <SelectItem key={key} value={key}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Select value={outcome} onValueChange={setOutcome}>
                        <SelectTrigger label="Status" aria-label="Filter task status">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[
                            ['all', 'All statuses'],
                            ['active', 'Running'],
                            ['review', 'Needs review'],
                            ['succeeded', 'Completed'],
                            ['failed', 'Failed'],
                            ['interrupted', 'Interrupted'],
                            ['unconfirmed', 'Unconfirmed'],
                            ['cancelled', 'Cancelled'],
                          ].map(([value, label]) => (
                            <SelectItem key={value} value={value ?? 'all'}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Select value={days} onValueChange={setDays}>
                        <SelectTrigger label="Date" aria-label="Filter activity date">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any time</SelectItem>
                          <SelectItem value="1">Last 24 hours</SelectItem>
                          <SelectItem value="7">Last 7 days</SelectItem>
                          <SelectItem value="30">Last 30 days</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {activeFilters ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSource('all');
                          setOutcome('all');
                          setDays('all');
                        }}
                      >
                        Clear filters
                      </button>
                    ) : null}
                  </div>
                </ActivityDisclosure>
              </>
            )}
            {selected ? (
              selectedRecord ? (
                <TaskDetails record={selectedRecord} close={close} dismiss={view === 'history' ? undefined : dismissSetupFailure} />
              ) : (
                <div className="task-centre-empty">
                  <h3>Record no longer available</h3>
                  <p>It may have left the available history. Return to activity to refresh the list.</p>
                </div>
              )
            ) : (
              <>
                {visibility.unsaved ? (
                  <p className="task-centre-notice">
                    Activity visibility could not be saved on this browser. Hidden items may return after reloading.
                  </p>
                ) : null}
                {visibility.undoAvailable && view !== 'history' ? (
                  <output className="task-centre-undo">
                    <span className="task-centre-undo-copy">Activity hidden. Records are still in History.</span>
                    <button
                      type="button"
                      data-activity-undo
                      onFocus={() => {
                        undoFocused.current = true;
                      }}
                      onBlur={() => {
                        undoFocused.current = false;
                      }}
                      onClick={() => {
                        visibility.undo();
                      }}
                    >
                      Undo
                    </button>
                  </output>
                ) : null}
                {criticalUpdate ? (
                  <Link className="task-centre-notice" to="/updates" onClick={close}>
                    Review critical Orbis update
                  </Link>
                ) : null}
                {pendingRequests && !records.some((record) => record.incoming) ? (
                  <Link className="task-centre-notice" to="/settings?tab=backups" onClick={close}>
                    Review {pendingRequests} restore requests
                  </Link>
                ) : null}
                {rows.length ? (
                  view === 'all' ? (
                    (['active', 'review', 'recent'] as const).map((bucket) => {
                      const matching = rows.filter((record) => record.bucket === bucket);
                      return matching.length ? (
                        <section className="task-centre-group" key={bucket}>
                          <div className="task-centre-group-heading">
                            <h3>
                              {bucket === 'active' ? 'Running' : bucket === 'review' ? 'Needs attention' : 'Recent activity'}
                              <span>{matching.reduce((count, record) => count + record.attempts.length, 0)}</span>
                            </h3>
                            {bucket !== 'active' && visibility.enabled && (bucket === 'review' ? attentionClearable : clearable) ? (
                              <button
                                type="button"
                                onClick={() => clearActivity(bucket)}
                                aria-label={bucket === 'review' ? 'Clear all dismissible needs-attention activity' : 'Clear all recent activity'}
                                title={
                                  bucket === 'review'
                                    ? 'Hide dismissible alerts; pending reviews remain available'
                                    : 'Hide recent activity from this feed'
                                }
                              >
                                Clear all
                              </button>
                            ) : null}
                          </div>
                          <ol>
                            {matching.map((record) => (
                              <TaskRow key={record.key} record={record} select={select} dismiss={visibility.enabled ? dismissRow : undefined} />
                            ))}
                          </ol>
                        </section>
                      ) : null;
                    })
                  ) : (
                    <section className="task-centre-group">
                      <div className="task-centre-group-heading">
                        <h3>
                          {view === 'active' ? 'Running' : view === 'review' ? 'Needs attention' : 'History'}
                          <span>{filtered.length} records</span>
                        </h3>
                        {view === 'review' && visibility.enabled && attentionClearable ? (
                          <button
                            type="button"
                            onClick={() => clearActivity('review')}
                            aria-label="Clear all dismissible needs-attention activity"
                            title="Hide dismissible alerts; pending reviews remain available"
                          >
                            Clear all
                          </button>
                        ) : null}
                      </div>
                      <ol>
                        {rows.map((record) => (
                          <TaskRow
                            key={record.key}
                            record={record}
                            select={select}
                            dismiss={visibility.enabled && view !== 'history' ? dismissRow : undefined}
                          />
                        ))}
                      </ol>
                    </section>
                  )
                ) : (
                  <div className="task-centre-empty">
                    <IconCheck size={26} aria-hidden="true" />
                    <h3>
                      {query.trim() || activeFilters
                        ? 'No matching operations'
                        : reading
                          ? 'Reading operations'
                          : unavailable
                            ? 'No activity to show'
                            : view === 'active'
                              ? 'Nothing running'
                              : view === 'review'
                                ? 'Nothing needs attention'
                                : view === 'history'
                                  ? 'No recorded operations'
                                  : 'No recent activity'}
                    </h3>
                    <p>
                      {query.trim() || activeFilters
                        ? 'Try another search or clear the filters.'
                        : unavailable
                          ? 'Activity may appear when more sources respond.'
                          : 'Installs, updates, backups and restores appear here.'}
                    </p>
                  </div>
                )}
                {rows.length && !counts.active && view === 'all' && !unavailable && !reading ? (
                  <p className="task-centre-idle">Nothing running</p>
                ) : null}
                {view === 'history' ? <p className="task-centre-retention">App history retains up to 300 operations for 30 days.</p> : null}
              </>
            )}
          </ActivityStage>
        </AnimatePresence>
        <motion.div
          className="task-centre-requests"
          hidden={!selectedRecord?.incoming}
          initial={false}
          animate={{ x: selectedRecord?.incoming || reduced ? '0%' : '100%' }}
          transition={reduced ? { duration: 0 } : activitySlide}
        >
          <SourceRestoreRequests requestId={selectedRecord?.incoming?.id} />
        </motion.div>
      </div>
    </div>
  );
}

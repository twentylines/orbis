import { Link } from 'react-router';
import { formatBackupBytes } from '@/modules/system-backups/contracts';
import type { SystemActivityRecord, SystemActivitySnapshot } from './system-task-activity';
import './system-task-activity.css';

export function SystemActivityNotices({ activity }: { activity: SystemActivitySnapshot }) {
  return (
    <>
      {activity.loading ? <output>Reading system activity…</output> : null}
      {activity.notices.map((notice) => (
        <p className="system-task-notice" key={notice}>
          {notice}
        </p>
      ))}
    </>
  );
}

export function SystemActivityRow({ record, close }: { record: SystemActivityRecord; close?: () => void }) {
  return (
    <li className="system-task-record">
      <strong>{record.title}</strong>
      <span>
        {record.status}
        {record.stale ? ' · last reported' : ''}
      </span>
      {record.time ? (
        <time dateTime={new Date(record.time).toISOString()}>{new Date(record.time).toLocaleString()}</time>
      ) : (
        <small>Latest reported job · time not provided</small>
      )}
      {record.completed !== undefined ? (
        <small>
          {formatBackupBytes(record.completed)}
          {record.total === null || record.total === undefined ? ' reported' : ` of ${formatBackupBytes(record.total)} reported`}
        </small>
      ) : null}
      {record.bucket === 'active' &&
      !record.stale &&
      record.completed !== undefined &&
      record.total !== null &&
      record.total !== undefined &&
      record.total > 0 &&
      record.completed <= record.total ? (
        <progress max={record.total} value={record.completed} aria-label={`${record.title} progress`} />
      ) : null}
      <Link to={record.path} onClick={close}>
        {record.action}
      </Link>
    </li>
  );
}

export function SystemTaskActivitySection({ activity, filter = 'all' }: { activity: SystemActivitySnapshot; filter?: string }) {
  const records = activity.records.filter(
    (record) =>
      filter === 'all' ||
      (filter === 'active' ? record.bucket === 'active' : filter === 'review' ? record.bucket === 'review' : record.bucket === 'recent'),
  );
  const latest = records.filter((record) => record.feed === 'restore');
  const dated = records.filter((record) => record.feed !== 'restore');
  return (
    <section className="system-task-activity" aria-label="System activity">
      <h2>System activity</h2>
      <SystemActivityNotices activity={activity} />
      {latest.length ? (
        <section aria-label="Latest settings restore">
          <h3>Latest settings restore</h3>
          <ol>
            {latest.map((record) => (
              <SystemActivityRow key={record.key} record={record} />
            ))}
          </ol>
        </section>
      ) : null}
      {dated.length ? (
        <ol>
          {dated.map((record) => (
            <SystemActivityRow key={record.key} record={record} />
          ))}
        </ol>
      ) : activity.loading || latest.length ? null : (
        <p>{activity.incomplete ? 'System activity could not be fully checked.' : 'No system activity in the available records.'}</p>
      )}
    </section>
  );
}

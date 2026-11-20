import { expect, test } from 'bun:test';
import { type } from 'arktype';
import { taskRecordSchema, type TaskRecord } from '@runtipi/common/schemas/task-history';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { taskProgressLabel } from './task-progress';
import { desktopActivity } from './desktop-activity-state';
import { taskCentreRecords } from './task-centre-model';
import { TaskDetails } from './desktop-task-panel';

const task: TaskRecord = {
  id: '00000000-0000-4000-8000-000000000001',
  appUrn: 'photos:official' as TaskRecord['appUrn'],
  action: 'update',
  status: 'running',
  phase: 'pulling_images',
  createdAt: '2026-11-19T10:00:00Z',
  updatedAt: '2026-11-19T10:00:10Z',
  startedAt: '2026-11-19T10:00:01Z',
  finishedAt: null,
};

test('the same server phase reaches the dock and Task Centre without fabricating a percentage', () => {
  const parsed = taskRecordSchema.assert(JSON.parse(JSON.stringify(task)));
  expect(taskProgressLabel(parsed)).toBe('Downloading images');
  expect(desktopActivity([parsed], new Map(), null, null)?.items[0]?.detail).toBe('Downloading images');
  const record = taskCentreRecords({ tasks: [parsed] })[0];
  if (!record) throw new Error('Task was omitted from the Task Centre');
  expect(record).toMatchObject({ status: 'Downloading images', outcome: 'active' });
  expect(record.phase).toBeUndefined();
  expect(record.progress).toBeUndefined();
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <TaskDetails record={{ ...record, attempts: [record] }} close={() => undefined} />
    </MemoryRouter>,
  );
  expect(markup).toContain('Downloading images');
  expect(markup.match(/Downloading images/g)).toHaveLength(1);
  expect(markup).not.toContain('%');
});

test.each(['succeeded', 'failed', 'interrupted', 'unconfirmed', 'queued'] as const)('a retained phase cannot make %s work look active', (status) => {
  expect(taskProgressLabel({ ...task, status })).toBeUndefined();
  const record = taskCentreRecords({ tasks: [{ ...task, status }] })[0];
  if (!record) throw new Error('Retained task was omitted from the Task Centre');
  expect(record.status).not.toBe('Downloading images');
});

test('older task records remain valid while unknown phase payloads are rejected', () => {
  const { phase, ...legacy } = task;
  expect(phase).toBe('pulling_images');
  expect(taskRecordSchema(legacy)).not.toBeInstanceOf(type.errors);
  expect(taskRecordSchema({ ...task, phase: 'arbitrary server message' })).toBeInstanceOf(type.errors);
});

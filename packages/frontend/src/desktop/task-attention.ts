import type { TaskRecord } from '@runtipi/common/schemas/task-history';

export const taskAttentionKey = (task: TaskRecord) =>
  ['failed', 'interrupted', 'unconfirmed'].includes(task.status) ? `${task.id}:${task.status}:${task.updatedAt}` : null;

export const taskAttentionStorageKey = 'orbis-task-attention-read-v1';
export function readTaskAcknowledgements(storage?: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = storage?.getItem(taskAttentionStorageKey);
    if (!raw || raw.length > 64 * 1024) return [];
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.length <= 301 && value.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 128)
      ? value
      : [];
  } catch {
    return [];
  }
}

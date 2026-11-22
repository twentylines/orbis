import type { AppJob } from '@runtipi/common/schemas/app-job';

export function createServerClock(monotonic = () => performance.now()) {
  let epoch: number | undefined;
  let observed = 0;
  return {
    observe(value: number) {
      if (!Number.isFinite(value) || value < 0) return;
      const current = monotonic();
      epoch = Math.max(value, epoch === undefined ? value : epoch + Math.max(0, current - observed));
      observed = current;
    },
    now() {
      return epoch === undefined ? undefined : epoch + Math.max(0, monotonic() - observed);
    },
  };
}

export function jobElapsed(job: AppJob, now?: number) {
  const end = ['queued', 'running', 'cancelling'].includes(job.status) ? now : job.updatedAt;
  if (end === undefined || !Number.isFinite(end) || job.startedAt > end) return null;
  const seconds = Math.floor((end - job.startedAt) / 1000);
  return seconds >= 3600
    ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`
    : seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
}

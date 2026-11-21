const phases = [
  'preparing',
  'downloading',
  'verifying',
  'staging',
  'prepared',
  'installing',
  'rolling-back',
  'rolled-back',
  'recovery-required',
  'failed',
  'interrupted',
  'complete',
] as const;
const files = [
  'activation-tool',
  'verification-tool',
  'staging-tool',
  'verifier-bootstrap',
  'toolkit-license',
  'verifier',
  'release',
  'signature',
] as const;
const version = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?![\s\S])/;
const id = /^[a-f0-9]{32}(?![\s\S])/;
export const sentinelUpdateProgressMaxBytes = 8192;

export type SentinelUpdateJob = {
  id: string;
  version: string;
  phase: (typeof phases)[number];
  startedAt: number;
  updatedAt: number;
  download: { file: (typeof files)[number]; currentBytes: number; totalBytes: number | null } | null;
};
export type SentinelUpdateProgress = { version: 1; available: boolean; jobs: SentinelUpdateJob[] };

export function sentinelUpdateActive(job: SentinelUpdateJob) {
  return ['preparing', 'downloading', 'verifying', 'staging', 'installing', 'rolling-back'].includes(job.phase);
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function count(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function download(value: unknown): value is NonNullable<SentinelUpdateJob['download']> {
  const maximum = 72 * 1024 * 1024;
  return (
    exactObject(value, ['file', 'currentBytes', 'totalBytes']) &&
    files.some((file) => file === value.file) &&
    count(value.currentBytes, 0, maximum) &&
    (value.totalBytes === null || count(value.totalBytes, Math.max(1, value.currentBytes), maximum))
  );
}

function job(value: unknown): value is SentinelUpdateJob {
  return (
    exactObject(value, ['id', 'version', 'phase', 'startedAt', 'updatedAt', 'download']) &&
    typeof value.id === 'string' &&
    id.test(value.id) &&
    typeof value.version === 'string' &&
    value.version.length <= 128 &&
    version.test(value.version) &&
    phases.some((phase) => phase === value.phase) &&
    count(value.startedAt, 1) &&
    count(value.updatedAt, value.startedAt) &&
    (value.phase === 'downloading' ? download(value.download) : value.download === null)
  );
}

export function parseSentinelUpdateProgress(value: unknown): SentinelUpdateProgress | undefined {
  if (
    !exactObject(value, ['version', 'available', 'jobs']) ||
    value.version !== 1 ||
    typeof value.available !== 'boolean' ||
    !Array.isArray(value.jobs) ||
    value.jobs.length > 16 ||
    !value.jobs.every(job) ||
    new Set(value.jobs.map(({ id }) => id)).size !== value.jobs.length
  )
    return;
  return { version: 1, available: value.available, jobs: value.jobs };
}

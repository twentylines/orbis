import { type } from 'arktype';

const count = type('0 <= number.integer <= 9007199254740991');
const download = type({
  schema: "'orbis.download-progress.v1'",
  phase: "'downloading' | 'extracting' | 'complete'",
  currentBytes: count,
  totalBytes: count.or('null'),
  totalKnown: 'boolean',
  alreadyCached: 'boolean',
  layersComplete: count,
  layersTotal: count,
  updatedAt: 'number > 0',
})
  .onUndeclaredKey('reject')
  .narrow(
    (item) =>
      Number.isFinite(item.updatedAt) &&
      item.totalKnown === (item.totalBytes !== null) &&
      (item.totalBytes === null || item.currentBytes <= item.totalBytes) &&
      item.layersComplete <= item.layersTotal &&
      (!item.alreadyCached || (item.phase === 'complete' && item.currentBytes === 0 && item.totalBytes === 0)),
  );

const job = type({
  id: type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)),
  state: "'queued' | 'running' | 'recovering' | 'complete' | 'failed' | 'interrupted'",
  targetTag: type('string <= 100').narrow((value) => /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(value)),
  phase: "null | 'downloading' | 'installing' | 'restarting' | 'verifying' | 'recovering'",
  'download?': download,
}).onUndeclaredKey('reject');
const schema = type({ version: '1', job: job.or('null') }).onUndeclaredKey('reject');
export type CoreUpdateProgress = typeof schema.infer;
export function parseCoreUpdateProgress(value: unknown): CoreUpdateProgress {
  if (!schema.allows(value)) throw new Error('Core update progress is unavailable.');
  return value;
}

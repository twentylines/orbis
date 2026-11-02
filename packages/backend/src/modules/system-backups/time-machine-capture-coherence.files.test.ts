import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCaptureCoherenceReceipt, verifyCaptureCoherenceReceipt } from './time-machine-capture-coherence';
import { runtimePayload } from './time-machine-runtime-payload';
function descriptor(): Parameters<typeof createCaptureCoherenceReceipt>[0] {
  const pauseId = randomUUID();
  const queues = [
    { name: 'app-events-queue' as const, messages: 0 as const, consumers: 0 as const },
    { name: 'repo-queue' as const, messages: 0 as const, consumers: 0 as const },
    { name: 'system-events-queue' as const, messages: 0 as const, consumers: 0 as const },
  ];
  return {
    schema: 'orbis.capture-coherence.v1',
    scope: 'orbis-managed-writers.v1',
    pointId: randomUUID(),
    transactionId: randomUUID(),
    createdAt: 1,
    managedWritesHeldAt: 3,
    sealedAt: 7,
    database: { containerId: 'a'.repeat(64), bytes: 5, sha256: 'b'.repeat(64) },
    manifestSha256: 'c'.repeat(64),
    apps: [{ id: 'd'.repeat(64), project: 'fixture_store', wasRunning: true, state: 'stopped' }],
    queueStart: { pauseId, generation: 1, checkedAt: 2, queues: structuredClone(queues) },
    queueEnd: { pauseId, generation: 1, checkedAt: 6, queues: structuredClone(queues) },
    hostFence: { configurationSetSha256: 'e'.repeat(64), preparationSha256: 'f'.repeat(64), verifiedAt: 5 },
    publicationProofSha256: '1'.repeat(64),
    imageCaptureSha256: '2'.repeat(64),
    imageInventorySha256: '3'.repeat(64),
    controllerAuthoritySha256: '4'.repeat(64),
  };
}
it('binds every observed snapshot component to the point through a canonical domain hash', () => {
  const receipt = createCaptureCoherenceReceipt(descriptor());
  expect(
    verifyCaptureCoherenceReceipt(receipt, {
      pointId: receipt.pointId,
      manifestSha256: receipt.manifestSha256,
      databaseId: receipt.database.containerId,
    }),
  ).toEqual(receipt);
  expect(() => verifyCaptureCoherenceReceipt({ ...receipt, database: { ...receipt.database, sha256: '9'.repeat(64) } })).toThrow();
  const forged = createCaptureCoherenceReceipt({ ...descriptor(), pointId: receipt.pointId, imageCaptureSha256: '9'.repeat(64) });
  expect(() => verifyCaptureCoherenceReceipt(forged, { imageCaptureSha256: receipt.imageCaptureSha256 })).toThrow();
});
it.each(['time', 'generation', 'pause', 'queues', 'apps'] as const)('refuses an impossible or incomplete managed writer cut: %s', (kind) => {
  const value = descriptor();
  if (kind === 'time') value.queueEnd.checkedAt = value.hostFence.verifiedAt - 1;
  if (kind === 'generation') value.queueEnd.generation++;
  if (kind === 'pause') value.queueEnd.pauseId = randomUUID();
  if (kind === 'queues') value.queueEnd.queues[1] = { ...value.queueEnd.queues[0], name: 'app-events-queue', messages: 0, consumers: 0 };
  if (kind === 'apps') value.apps.push({ ...value.apps[0], id: 'd'.repeat(64), project: 'fixture_store', wasRunning: true, state: 'stopped' });
  expect(() => createCaptureCoherenceReceipt(value)).toThrow();
});
it.each(['authority', 'coherence'])('never silently downgrades a partial v3 producer input: %s', (kind) => {
  const input = kind === 'authority' ? { controllerAuthority: {} } : { coherence: {} };
  expect(() => runtimePayload(input as never, {} as never, new AbortController().signal)).toThrow();
});

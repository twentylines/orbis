import path from 'node:path';
import { privateBackupDirectory } from './backup-files';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { validateCorePayloadExpectation } from './time-machine-core-payload';
import { verifyCoreSavedPoint } from './time-machine-core-verify';
import { coreSentinelRecoveryCapability } from './time-machine-core-recovery-contract';

export const corePublicationCapability = Object.freeze({
  schema: 'orbis.core-capture-publication-capability.v1',
  version: 1,
  pointVersion: 3,
  payloadFormat: 'orbis.time-machine-core.v1',
  publicationSchema: 'orbis.core-capture-publication.v1',
  dataRoot: '/data',
  verification: 'authenticated-stream-and-images.v1',
  mutations: 'private-verification-staging-only',
});

export function parseCorePublicationArguments(args: readonly string[]) {
  if (args.length === 1 && args[0] === '--capability') return { mode: 'capability' as const };
  if (args.length === 1 && args[0] === '--sentinel-recovery-capability') return { mode: 'sentinel-recovery-capability' as const };
  if (args.length !== 2 || args[0] !== '--verify' || typeof args[1] !== 'string' || args[1].length > 8192)
    throw new Error('Invalid capture verification invocation.');
  const expectation = validateCorePayloadExpectation(JSON.parse(args[1]));
  if (canonicalPublicationJson(expectation) !== args[1]) throw new Error('Invalid capture verification invocation.');
  return { mode: 'verify' as const, expectation };
}

/** Root invokes this independent process; web requests cannot choose storage paths. */
export async function runCorePublicationWorker(args: readonly string[]) {
  const operation = parseCorePublicationArguments(args);
  if (operation.mode === 'capability') return corePublicationCapability;
  if (operation.mode === 'sentinel-recovery-capability') return coreSentinelRecoveryCapability;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Capture verification requires the Linux root context.');
  const dataDir = '/data';
  const stagingDirectory = path.join(dataDir, 'backups/time-machine/core-verification');
  await privateBackupDirectory(stagingDirectory);
  return verifyCoreSavedPoint({ dataDir, expectation: operation.expectation, stagingDirectory, signal: AbortSignal.timeout(30 * 60_000) });
}

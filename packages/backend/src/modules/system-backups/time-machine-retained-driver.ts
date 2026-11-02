import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import Dockerode from 'dockerode';
import { type } from 'arktype';
import { APP_DATA_DIR, DATA_DIR } from '@/common/constants';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readTerminalJson } from './backup-restore-terminal-record';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { retainedRootBindingSchema } from './time-machine-retained-bootstrap';
import { readRetainedRestoreContext } from './time-machine-retained-context';
import { RetainedPhaseClient } from './time-machine-retained-phase-client';
import { runAuthenticatedRetainedPhase } from './time-machine-retained-phase-bridge';
import { readRootBoundImageExpectations, retainedImageDocker } from './time-machine-retained-images';
import { retainedPhaseRuntime } from './time-machine-retained-runtime';
import type { RetainedPhase } from './time-machine-retained-phases';

const capsuleSchema = type({ version: '1', transactionId: 'string', token: 'string' }).onUndeclaredKey('reject');
const fail = () => new Error('Protected retained restore requires recovery.');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function decodeRetainedPhaseInput(id: string, phase: string, bytes: Uint8Array) {
  if (!uuid.test(id) || !['prepare', 'promote', 'verify', 'rollback', 'commit'].includes(phase) || bytes.byteLength > 4096) throw fail();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw fail();
  }
  const capsule = capsuleSchema(raw);
  if (capsule instanceof type.errors || capsule.transactionId !== id || !/^[a-f0-9]{64}$/.test(capsule.token)) throw fail();
  return { phase: phase as RetainedPhase, token: capsule.token };
}

export async function readRetainedPhaseInput(stream: Readable, id: string, phase: string, signal: AbortSignal) {
  const parts: Buffer[] = [];
  let size = 0;
  const abort = () => stream.destroy(fail());
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 4096) {
        stream.destroy();
        throw fail();
      }
      parts.push(bytes);
    }
    signal.throwIfAborted();
    return decodeRetainedPhaseInput(id, phase, Buffer.concat(parts));
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// Only a running root phase grant can authenticate this driver and its bound private context.
export async function runRetainedPhaseDriver(options: { id: string; phase: RetainedPhase; token: string; signal: AbortSignal }) {
  if (
    !uuid.test(options.id) ||
    !['prepare', 'promote', 'verify', 'rollback', 'commit'].includes(options.phase) ||
    !/^[a-f0-9]{64}$/.test(options.token)
  )
    throw fail();
  const journal = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
  if (!journal || journal.state.id !== options.id) throw fail();
  const record = await readTerminalJson(path.join(journal.directory, 'retained-binding.json'));
  if (!record || typeof record !== 'object' || !('binding' in record)) throw fail();
  const binding = retainedRootBindingSchema(record.binding);
  if (binding instanceof type.errors || binding.restoreId !== options.id) throw fail();
  const receipt = await readRetainedRestoreReceipt(journal);
  if (!receipt || receipt.binding.pointId !== binding.pointId) throw fail();
  const client = new RetainedPhaseClient('/run/orbis/host.sock', options.id, options.token);
  const docker = new Dockerode();
  const directories = { data: DATA_DIR, appData: APP_DATA_DIR, cache: '/cache' };
  return runAuthenticatedRetainedPhase({
    client,
    journal,
    phase: options.phase,
    signal: options.signal,
    expected: {
      restoreId: options.id,
      nonce: binding.nonce,
      pointId: binding.pointId,
      workerId: binding.workerId,
      originalController: binding.originalController,
      candidateController: binding.candidateController,
      verifierController: binding.verifierController,
      target: binding.target,
    },
    runtime: async (status) => {
      const rootBinding = status.binding;
      const expected = await readRootBoundImageExpectations({
        dataDirectory: DATA_DIR,
        restoreId: options.id,
        manifestSha256: rootBinding.sourceBinding.runtimeManifestSha256,
        pointId: rootBinding.pointId,
        target: rootBinding.target,
        signal: options.signal,
      });
      const preserveLiveProxy =
        expected.expectedManifest.schema === 'orbis.time-machine-runtime.v4' || expected.expectedManifest.schema === 'orbis.time-machine-runtime.v6';
      const context = await readRetainedRestoreContext({
        journal,
        rootBinding,
        expectedPointId: receipt.binding.pointId,
        expectedRuntimeManifestSha256: rootBinding.sourceBinding.runtimeManifestSha256,
        ownerId: receipt.ownerId,
        importId: receipt.importId,
        docker,
        hostname: os.hostname(),
        committed: status.state === 'active' && status.decision === 'commit',
        preserveLiveProxy,
        directories,
      });
      return retainedPhaseRuntime({
        journal,
        runtime: context.runtime,
        bootstrap: context.bootstrap,
        hostname: os.hostname(),
        directories,
        migrationsPath: rootBinding.migrationsPath,
        preserveLiveProxy,
        imageAdmission: { ...expected, docker: retainedImageDocker(docker, (bytes, signal) => client.imagePreflight(bytes, signal)) },
        confirmRootActivation: async () => undefined,
        progress: () => undefined,
      });
    },
  });
}

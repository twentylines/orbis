import { addAbortSignal, type Readable } from 'node:stream';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { readTarStream } from '@/core/archive/tar-metadata';
import { BackupRequirementError } from './backup-files';

const capabilityName = 'restore-install-hold-capability.json';
const capabilityPath = `/app/${capabilityName}`;
const schema = 'orbis.restore-install-hold-effect.v1';
const policy = 'verified-live-store-before-app-resume.v1';

export class RestoreWorkerCompatibilityError extends BackupRequirementError {
  readonly runtimeCheck = 'worker-install-hold-capability';
  constructor() {
    super('This restore worker lacks verified app install recovery protection. Keep the existing restore for protected recovery.');
  }
}

type WorkerPin = { worker: string; id: string; nonce: string; image: string };

function verifyDefinition(worker: Dockerode.ContainerInspectInfo, pin: WorkerPin) {
  const { Config: config, HostConfig: host } = worker;
  const restart = host.RestartPolicy;
  const targets = worker.Mounts.map((mount) => mount.Destination);
  if (
    !/^[a-f0-9]{64}$/.test(pin.worker) ||
    !/^sha256:[a-f0-9]{64}$/.test(pin.image) ||
    worker.Id !== pin.worker ||
    worker.Image !== pin.image ||
    config.Labels?.['io.orbis.restore'] !== pin.id ||
    config.Labels?.['io.orbis.restore.nonce'] !== pin.nonce ||
    config.Labels?.['io.orbis.restore.role'] !== 'worker' ||
    config.WorkingDir !== '/app' ||
    config.Entrypoint?.length !== 1 ||
    config.Entrypoint[0] !== 'node' ||
    config.Cmd?.length !== 2 ||
    config.Cmd[0] !== '/app/restore-worker.mjs' ||
    config.Cmd[1] !== pin.id ||
    host.ReadonlyRootfs !== true ||
    restart?.Name !== 'no' ||
    restart.MaximumRetryCount !== 0 ||
    worker.State.Paused ||
    worker.State.Restarting ||
    worker.State.Dead ||
    Object.keys(host.Tmpfs ?? {}).some((target) => target !== '/tmp') ||
    targets.some((target) => target !== path.posix.resolve(target) || target === '/' || target === '/app' || target.startsWith('/app/'))
  )
    throw new RestoreWorkerCompatibilityError();
}

function verifyDeclaration(bytes: Buffer) {
  const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(json);
  if (
    value?.schema !== schema ||
    value?.version !== 1 ||
    value?.policy !== policy ||
    Object.keys(value).length !== 3 ||
    // Round-trip comparison also rejects duplicate properties.
    JSON.stringify(value) !== json.replace(/[ \t\r\n]/g, '')
  )
    throw new RestoreWorkerCompatibilityError();
}

/** The operation's pin must come from the protected controller's restore records. */
export async function verifyStandaloneWorkerCapability(docker: Dockerode, worker: Dockerode.ContainerInspectInfo, pin: WorkerPin) {
  try {
    verifyDefinition(worker, pin);
    const image = await docker.getImage(worker.Image).inspect();
    if (image.Id !== pin.image) throw new RestoreWorkerCompatibilityError();
    const container = docker.getContainer(worker.Id);
    const signal = AbortSignal.timeout(5000);
    const source = addAbortSignal(signal, (await container.getArchive({ path: capabilityPath, abortSignal: signal })) as Readable);
    const chunks: Buffer[] = [];
    const entries = await readTarStream(source, false, signal, {
      strict: true,
      maxEntries: 1,
      maxExpandedBytes: 16_384,
      onEntry: async (entry) => {
        if (entry.path !== capabilityName || entry.type !== '-' || entry.size <= 0 || entry.size > 4096) throw new RestoreWorkerCompatibilityError();
      },
      onData: async (chunk) => {
        chunks.push(chunk);
      },
    });
    if (entries.length !== 1) throw new RestoreWorkerCompatibilityError();
    verifyDeclaration(Buffer.concat(chunks));
    const current = await container.inspect({ abortSignal: signal });
    signal.throwIfAborted();
    verifyDefinition(current, pin);
    return current;
  } catch {
    throw new RestoreWorkerCompatibilityError();
  }
}

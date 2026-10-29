import fs, { constants } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type } from 'arktype';
import type { RestoreJournal } from './backup-restore-journal';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const location = type('string > 0 & string <= 4096').narrow(
  (value) => path.isAbsolute(value) && path.resolve(value) === value && value !== '/' && !/[\r\n\0\\]/.test(value),
);
const roots = type({
  '+': 'reject',
  state: location,
  apps: location,
  repos: location,
  media: location,
  'user-config': location,
  traefik: location,
  'app-data': location,
});
const layout = type({ '+': 'reject', roots, backups: location, logs: location, environment: location, cache: location });
export const terminalOwnershipSchema = type({
  '+': 'reject',
  version: '1',
  id: uuid,
  nonce: uuid,
  original: hash,
  fingerprint: hash,
  image: type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value)),
  name: type('string > 0 & string <= 256').narrow((value) => /^\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)),
  worker: type({ '+': 'reject', id: hash, fingerprint: hash }),
  verifier: type({ '+': 'reject', id: hash, fingerprint: hash }),
  apps: hash.array().atMostLength(1024),
  connection: type({
    '+': 'reject',
    host: 'string > 0 & string <= 4096',
    user: 'string > 0 & string <= 4096',
    port: 'number.integer > 0 & number <= 65535',
    database: 'string > 0 & string <= 4096',
  }),
  project: type('string').narrow((value) => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value)),
  root: location,
  configFiles: location.array().atLeastLength(1).atMostLength(8),
  layout,
  networks: type('string > 0 & string <= 255').array().atLeastLength(1).atMostLength(16),
  mainNetwork: 'string > 0 & string <= 255',
  mountsHash: hash,
  securityHash: hash,
  workingDirectory: location,
  command: type('string <= 4096').array().atMostLength(16),
  entrypoint: type('string <= 4096').array().atMostLength(16),
  protocol: "'orbis.installation-state.v1'",
});
export type TerminalOwnership = typeof terminalOwnershipSchema.infer;
export const terminalFailure = () =>
  new BackupRequirementError(
    'The settled restore needs controller ownership review. Keep the recorded server available; do not remove containers or retry restore until its managed storage and stopped auxiliaries are verified.',
  );
export const terminalPhase = (state: RestoreJournal) => ['completed', 'rolled-back', 'discarded'].includes(state.phase);
export async function readTerminalJson(file: string, limit = 512 * 1024): Promise<unknown | undefined> {
  let parent: Stats;
  try {
    parent = await fs.lstat(path.dirname(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw terminalFailure();
  }
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    (process.getuid && parent.uid !== process.getuid()) ||
    (await fs.realpath(path.dirname(file))) !== path.resolve(path.dirname(file))
  )
    throw terminalFailure();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw terminalFailure();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > limit || (process.getuid && stat.uid !== process.getuid()))
      throw terminalFailure();
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } catch {
    throw terminalFailure();
  } finally {
    await handle.close();
  }
}
export async function writeTerminalJson(file: string, value: unknown, exclusive = false) {
  await privateBackupDirectory(path.dirname(file));
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 512 * 1024) throw terminalFailure();
  const temporary = path.join(path.dirname(file), `.terminal-${randomUUID()}`);
  const output = await fs.open(temporary, 'wx', 0o600);
  try {
    await output.writeFile(encoded);
    await output.sync();
    await output.close();
    if (exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
    await fs.rm(temporary, { force: true });
    const parent = await fs.open(path.dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await output.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}
export async function readTerminalOwnership(directory: string, state: RestoreJournal) {
  const raw = await readTerminalJson(path.join(directory, 'controller-ownership.json'));
  if (raw === undefined) return undefined;
  const value = terminalOwnershipSchema(raw);
  if (
    value instanceof type.errors ||
    value.id !== state.id ||
    value.nonce !== state.nonce ||
    value.original !== state.originalController ||
    value.worker.id !== state.worker ||
    value.verifier.id !== state.verifierController
  )
    throw terminalFailure();
  return value;
}
const latestSchema = type({ '+': 'reject', version: '1', id: uuid, nonce: uuid, phase: "'completed' | 'rolled-back' | 'discarded'" });
export async function readLatestTerminalPointer(store: string) {
  const raw = await readTerminalJson(path.join(store, 'latest-terminal.json'), 4096);
  if (raw === undefined) return undefined;
  const value = latestSchema(raw);
  if (value instanceof type.errors) throw terminalFailure();
  return value;
}
export async function retireTerminalControllers(store: string, ids: string[]) {
  const raw = await readTerminalJson(path.join(store, 'retired.json'));
  if (raw !== undefined && (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))))
    throw terminalFailure();
  const values = [...new Set([...((raw as string[] | undefined) ?? []), ...ids])];
  if (values.length > 4096 || values.some((value) => !/^[a-f0-9]{64}$/.test(value))) throw terminalFailure();
  await writeTerminalJson(path.join(store, 'retired.json'), values);
}

import { historicalIconLimits, historicalIconsAssetSchema, type HistoricalIconsAsset } from '@runtipi/common/schemas/time-machine-icons';
import { verifyAppIcons, type CapturedAppIcons } from './time-machine-app-icons';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { type } from 'arktype';
import {
  defaultTimeMachinePreferences,
  timeMachineIdSchema,
  timeMachineHashSchema,
  timeMachineLimits,
  timeMachineAssetLimit,
  timeMachineWallpaperAssetSchema,
  timeMachineMetadataSchema,
  timeMachinePreferencesSchema,
  timeMachineReasonSchema,
  type TimeMachineMetadata,
  type TimeMachinePreferences,
  type TimeMachinePreferencesUpdate,
  type TimeMachineReason,
  type TimeMachineWallpaperAsset,
  type TimeMachineRuntimeSummary,
} from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, encryptBackupStream, backupCipherOverhead } from './backup-crypto';
import { runtimePayload, runtimePayloadLimits, type CapturedRuntimeInput } from './time-machine-runtime-payload';
import { admitRuntimeFile, type RuntimeAdmissionExpectation } from './time-machine-runtime-reader';
import { privateBackupDirectory } from './backup-files';
import { timeMachineConflict } from './time-machine-policy';
import { capturedWallpaper, type CapturedWallpaper } from './time-machine-assets';
import { requireV6SealAdmission, reviewV6SealArchive, type V6SealAdmission } from './time-machine-v6-seal-admission';

const envelopeSchema = type({
  version: '1',
  keyId: timeMachineHashSchema,
  nonce: type('string').narrow((value) => /^[a-f0-9]{24}$/.test(value)),
  tag: type('string').narrow((value) => /^[a-f0-9]{32}$/.test(value)),
  value: type('string').narrow((value) => /^[a-f0-9]{86}$/.test(value)),
}).onUndeclaredKey('reject');
const legacyStoredPointSchema = type({
  version: '1',
  id: timeMachineIdSchema,
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  status: "'capturing' | 'sealed' | 'failed' | 'interrupted'",
  backupJobId: timeMachineIdSchema.or('null'),
  issue: timeMachineReasonSchema.or('null'),
  envelope: envelopeSchema,
  archiveBytes: '0 <= number.integer <= 9007199254740991',
  archiveSha256: timeMachineHashSchema.or('null'),
  metadataSha256: timeMachineHashSchema.or('null'),
  'assetBytes?': `0 <= number.integer <= ${timeMachineAssetLimit + historicalIconLimits.bundleBytes + 104}`,
  'onboardingAttemptId?': timeMachineIdSchema,
}).onUndeclaredKey('reject');
const runtimeStoredPointSchema = legacyStoredPointSchema
  .omit('version')
  .merge({
    version: '2',
    runtimeBytes: '0 <= number.integer <= 68719476756',
    runtimeCipherSha256: timeMachineHashSchema.or('null'),
    runtimeManifestSha256: timeMachineHashSchema.or('null'),
    imageCaptureSha256: timeMachineHashSchema.or('null'),
    imageInventorySha256: timeMachineHashSchema.or('null'),
    configurationSetSha256: timeMachineHashSchema.or('null'),
  })
  .onUndeclaredKey('reject');
const storedPointSchema = legacyStoredPointSchema.or(runtimeStoredPointSchema);
export type StoredTimeMachinePoint = typeof storedPointSchema.infer;
type Draft<T> = T extends unknown ? Omit<T, 'archiveBytes' | 'archiveSha256' | 'runtime'> : never;
export type TimeMachineDraftMetadata = Draft<TimeMachineMetadata>;
const sameStat = (first: Awaited<ReturnType<FileHandle['stat']>>, second: Awaited<ReturnType<FileHandle['stat']>>) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));

export class TimeMachineStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly dataDir: string) {}

  private root() {
    return path.join(this.dataDir, 'backups', 'time-machine');
  }
  private pointDirectory(id: string) {
    if (!timeMachineIdSchema.allows(id)) throw timeMachineConflict('point-not-found');
    return path.join(this.root(), 'points', id);
  }
  private async directory(directory: string, create = false) {
    if (create) await privateBackupDirectory(directory);
    else {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        throw timeMachineConflict('storage-unavailable');
      if ((await fs.realpath(directory)) !== path.resolve(directory)) throw timeMachineConflict('storage-unavailable');
    }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined).then(work);
    this.queue = pending;
    return pending;
  }
  private async read(file: string, maximum: number) {
    await this.directory(path.dirname(file));
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > maximum || (process.getuid && stat.uid !== process.getuid()))
        throw timeMachineConflict('storage-unavailable');
      const value = await handle.readFile();
      if (value.length !== stat.size || !sameStat(stat, await handle.stat())) throw timeMachineConflict('storage-unavailable');
      return value;
    } finally {
      await handle.close();
    }
  }
  private async sync(directory: string) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private async atomic(file: string, value: Buffer | string, replace: boolean) {
    const directory = path.dirname(file);
    await this.directory(directory, true);
    const temporary = path.join(directory, `.${randomUUID()}.partial`);
    try {
      const handle = await fs.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (replace) await fs.rename(temporary, file);
      else await fs.link(temporary, file);
      await fs.rm(temporary, { force: true });
      await this.sync(directory);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  private async masterKey(create: boolean) {
    const file = path.join(this.root(), 'keys', 'master-v1.key');
    let key: Buffer;
    try {
      key = await this.read(file, 32);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const generated = randomBytes(32);
      try {
        await this.atomic(file, generated, false);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
      } finally {
        generated.fill(0);
      }
      key = await this.read(file, 32);
    }
    if (key.length !== 32) throw timeMachineConflict('storage-unavailable');
    return key;
  }
  private aad(id: string, ownerId: number) {
    return Buffer.from(`orbis-time-machine-key-v1:${id}:${ownerId}`);
  }
  private async wrap(id: string, ownerId: number, passphrase: string) {
    const key = await this.masterKey(true);
    try {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(this.aad(id, ownerId));
      const value = Buffer.concat([cipher.update(passphrase, 'utf8'), cipher.final()]);
      return {
        version: 1 as const,
        keyId: createHash('sha256').update(key).digest('hex'),
        nonce: nonce.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        value: value.toString('hex'),
      };
    } finally {
      key.fill(0);
    }
  }
  private async unwrap(point: StoredTimeMachinePoint) {
    const key = await this.masterKey(false);
    try {
      if (createHash('sha256').update(key).digest('hex') !== point.envelope.keyId) throw timeMachineConflict('point-integrity-failed');
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(point.envelope.nonce, 'hex'));
      cipher.setAAD(this.aad(point.id, point.ownerId));
      cipher.setAuthTag(Buffer.from(point.envelope.tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(point.envelope.value, 'hex')), cipher.final()]).toString('utf8');
    } catch {
      throw timeMachineConflict('point-integrity-failed');
    } finally {
      key.fill(0);
    }
  }
  async preferences(): Promise<TimeMachinePreferences> {
    try {
      const value = JSON.parse((await this.read(path.join(this.root(), 'preferences.json'), 131_072)).toString());
      if (!timeMachinePreferencesSchema.allows(value)) throw timeMachineConflict('storage-unavailable');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultTimeMachinePreferences();
      throw error;
    }
  }
  updatePreferences(update: TimeMachinePreferencesUpdate) {
    return this.serialize(async () => {
      if (update.beforeUpdate || update.beforeRestart || update.schedule.enabled) throw timeMachineConflict('automatic-capture-unsupported');
      const current = await this.preferences();
      if (current.revision !== update.expectedRevision || current.revision === Number.MAX_SAFE_INTEGER)
        throw timeMachineConflict('revision-conflict');
      const { expectedRevision: _expected, ...value } = update;
      const next = timeMachinePreferencesSchema.assert({ ...value, version: 1, revision: current.revision + 1 });
      await this.atomic(path.join(this.root(), 'preferences.json'), JSON.stringify(next), true);
      return next;
    });
  }
  async list(): Promise<StoredTimeMachinePoint[]> {
    const directory = path.join(this.root(), 'points');
    let names: string[];
    try {
      await this.directory(directory);
      names = await fs.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (names.length > timeMachineLimits.points || names.some((name) => !timeMachineIdSchema.allows(name)))
      throw timeMachineConflict('storage-unavailable');
    try {
      const points = await Promise.all(names.map((name) => this.load(name)));
      return points.sort((first, second) => second.createdAt - first.createdAt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw timeMachineConflict('storage-unavailable');
      throw error;
    }
  }
  async load(id: string): Promise<StoredTimeMachinePoint> {
    const value = JSON.parse((await this.read(path.join(this.pointDirectory(id), 'point.json'), 32_768)).toString());
    if (!storedPointSchema.allows(value) || value.id !== id) throw timeMachineConflict('point-integrity-failed');
    return value;
  }
  async update(point: StoredTimeMachinePoint) {
    const current = await this.load(point.id);
    if (
      current.status === 'sealed' ||
      current.id !== point.id ||
      current.ownerId !== point.ownerId ||
      current.onboardingAttemptId !== point.onboardingAttemptId ||
      !storedPointSchema.allows(point)
    )
      throw timeMachineConflict('point-integrity-failed');
    await this.atomic(path.join(this.pointDirectory(point.id), 'point.json'), JSON.stringify(point), true);
  }
  async onboardingAttempt(id: string, ownerId: number, create = false) {
    if (!timeMachineIdSchema.allows(id) || !Number.isSafeInteger(ownerId) || ownerId < 1) throw timeMachineConflict('invalid-request');
    const directory = path.join(this.root(), 'onboarding-attempts');
    const file = path.join(directory, `${id}.json`);
    const machineId = await this.machineIdentity(create);
    let claimed = false;
    if (create) {
      await this.directory(directory, true);
      const entries = await fs.readdir(directory);
      if (entries.length >= 256 && !entries.includes(`${id}.json`)) throw timeMachineConflict('capacity-exceeded');
      try {
        await this.atomic(file, JSON.stringify({ version: 1, id, ownerId, machineId, state: 'reserved' }), false);
        claimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const value: unknown = JSON.parse((await this.read(file, 4096)).toString());
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'id,machineId,ownerId,state,version' ||
      !('id' in value && 'ownerId' in value && 'machineId' in value && 'state' in value && 'version' in value) ||
      value.version !== 1 ||
      value.id !== id ||
      value.ownerId !== ownerId ||
      value.machineId !== machineId ||
      (value.state !== 'reserved' && value.state !== 'ready')
    )
      throw timeMachineConflict('point-not-found');
    return { claimed, state: value.state };
  }

  async readyOnboardingAttempt(id: string, ownerId: number) {
    const current = await this.onboardingAttempt(id, ownerId);
    if (current.state !== 'reserved') throw timeMachineConflict('capture-recovery-required');
    const machineId = await this.machineIdentity();
    const file = path.join(this.root(), 'onboarding-attempts', `${id}.json`);
    await this.atomic(file, JSON.stringify({ version: 1, id, ownerId, machineId, state: 'ready' }), true);
  }

  create(ownerId: number, version: 1 | 2 = 1, onboardingAttemptId?: string) {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw timeMachineConflict('invalid-request');
      if (onboardingAttemptId !== undefined && (version !== 2 || !timeMachineIdSchema.allows(onboardingAttemptId)))
        throw timeMachineConflict('invalid-request');
      const points = await this.list();
      if (points.length) {
        const key = await this.masterKey(false);
        const keyId = createHash('sha256').update(key).digest('hex');
        key.fill(0);
        if (points.some((point) => point.envelope.keyId !== keyId)) throw timeMachineConflict('point-integrity-failed');
      }
      if (
        points.length >= timeMachineLimits.points ||
        points.reduce((sum, point) => sum + point.archiveBytes + (point.assetBytes ?? 0) + (point.version === 2 ? point.runtimeBytes : 0), 0) >=
          timeMachineLimits.bytes
      )
        throw timeMachineConflict('capacity-exceeded');
      const id = onboardingAttemptId ?? randomUUID();
      const passphrase = randomBytes(32).toString('base64url');
      const point = storedPointSchema.assert({
        version,
        id,
        ownerId,
        createdAt: Date.now(),
        status: 'capturing',
        backupJobId: null,
        issue: null,
        envelope: await this.wrap(id, ownerId, passphrase),
        archiveBytes: 0,
        archiveSha256: null,
        metadataSha256: null,
        ...(onboardingAttemptId ? { onboardingAttemptId } : {}),
        ...(version === 2
          ? {
              runtimeBytes: 0,
              runtimeCipherSha256: null,
              runtimeManifestSha256: null,
              imageCaptureSha256: null,
              imageInventorySha256: null,
              configurationSetSha256: null,
            }
          : {}),
      });
      if (onboardingAttemptId) {
        const destination = this.pointDirectory(id);
        await this.directory(path.dirname(destination), true);
        await fs.mkdir(destination, { mode: 0o700 });
        await this.atomic(path.join(destination, 'point.json'), JSON.stringify(point), false);
        await this.sync(path.dirname(destination));
      } else {
        await this.directory(this.pointDirectory(id), true);
        await this.atomic(path.join(this.pointDirectory(id), 'point.json'), JSON.stringify(point), false);
      }
      return { point, passphrase };
    });
  }
  async seal(
    point: StoredTimeMachinePoint,
    source: Readable,
    bytes: number,
    metadata: TimeMachineDraftMetadata,
    signal: AbortSignal,
    runtime?: { input: CapturedRuntimeInput; admission?: V6SealAdmission; progress?: (completed: number, total: number) => void },
  ) {
    const directory = this.pointDirectory(point.id);
    const temporary = path.join(directory, 'archive.partial');
    const sealedMetadata = path.join(directory, 'metadata.orbis');
    const runtimeTemporary = path.join(directory, 'runtime.partial');
    const linked: string[] = [];
    let output: FileHandle | undefined;
    try {
      if ((await this.load(point.id)).status !== 'capturing' || !Number.isSafeInteger(bytes) || bytes < 52)
        throw timeMachineConflict('point-integrity-failed');
      if (point.version !== metadata.version || (point.version === 2) !== Boolean(runtime)) throw timeMachineConflict('point-integrity-failed');
      const planned = runtime
        ? runtimePayload(runtime.input, { bytes, cipherSha256: '0'.repeat(64), manifestSha256: metadata.manifestSha256 }, signal)
        : null;
      planned?.stream.destroy();
      if (planned?.manifest.schema === 'orbis.time-machine-runtime.v6' && runtime)
        requireV6SealAdmission(runtime.admission, runtime.input, point, planned.manifest);
      const runtimeEstimate = planned ? planned.bytes + backupCipherOverhead : 0;
      const retained = (await this.list()).reduce(
        (sum, item) => sum + item.archiveBytes + (item.assetBytes ?? 0) + (item.version === 2 ? item.runtimeBytes : 0),
        0,
      );
      const assetBytes = metadata.preview.available
        ? (metadata.preview.wallpaperAsset.available ? metadata.preview.wallpaperAsset.bytes + 52 : 0) +
          (metadata.preview.appIcons ? metadata.preview.appIcons.bytes + 52 : 0)
        : 0;
      const space = await fs.statfs(directory);
      if (
        retained + bytes + runtimeEstimate + assetBytes > timeMachineLimits.bytes ||
        space.bavail * space.bsize < bytes + runtimeEstimate + 256 * 1024 * 1024
      )
        throw timeMachineConflict('capacity-exceeded');
      output = await fs.open(temporary, 'wx', 0o600);
      let received = 0;
      const hash = createHash('sha256');
      let prefix = Buffer.alloc(0);
      for await (const raw of source) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        received += chunk.length;
        if (received > bytes) throw timeMachineConflict('point-integrity-failed');
        if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
        if (prefix.length === 8 && prefix.toString() !== 'ORBISBK1') throw timeMachineConflict('point-integrity-failed');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await output.write(chunk, offset, chunk.length - offset);
          if (!result.bytesWritten) throw timeMachineConflict('storage-unavailable');
          offset += result.bytesWritten;
        }
      }
      if (received !== bytes) throw timeMachineConflict('point-integrity-failed');
      await output.sync();
      await output.close();
      output = undefined;
      const archiveSha256 = hash.digest('hex');
      let runtimeSummary: TimeMachineRuntimeSummary | undefined;
      let runtimeExpectation: RuntimeAdmissionExpectation | undefined;
      if (runtime && planned) {
        const payload = runtimePayload(runtime.input, { bytes, cipherSha256: archiveSha256, manifestSha256: metadata.manifestSha256 }, signal);
        if (payload.manifest.schema === 'orbis.time-machine-runtime.v6' || planned.manifest.schema === 'orbis.time-machine-runtime.v6') {
          try {
            requireV6SealAdmission(runtime.admission, runtime.input, point, payload.manifest);
          } catch (error) {
            payload.stream.destroy();
            throw error;
          }
        }
        if (payload.bytes !== planned.bytes) throw timeMachineConflict('point-integrity-failed');
        const encrypted = await encryptBackupStream({
          source: payload.stream,
          plaintextBytes: payload.bytes,
          destination: runtimeTemporary,
          passphrase: await this.unwrap(point),
          signal,
          onProgress: runtime.progress,
        });
        runtimeExpectation = {
          manifestSha256: payload.manifestSha256,
          manifest: payload.manifest,
          publication: runtime.input.publicationExpectation,
        };
        runtimeSummary = {
          version: 1,
          cipherBytes: encrypted.bytes,
          cipherSha256: encrypted.sha256,
          manifestSha256: payload.manifestSha256,
          imageCaptureSha256: payload.manifest.imageCaptureSha256,
          imageInventorySha256: payload.manifest.imageInventorySha256,
          configurationSetSha256: payload.manifest.configurationSetSha256,
          imageCount: payload.imageCount,
          bindingCount: payload.bindingCount,
          ...(payload.manifest.schema === 'orbis.time-machine-runtime.v3' ||
          payload.manifest.schema === 'orbis.time-machine-runtime.v4' ||
          payload.manifest.schema === 'orbis.time-machine-runtime.v6'
            ? { coherenceSha256: payload.manifest.coherenceSha256 }
            : {}),
        };
      }
      if (planned?.manifest.schema === 'orbis.time-machine-runtime.v6' && runtime?.admission && runtimeExpectation) {
        const current = runtimePayload(runtime.input, { bytes, cipherSha256: archiveSha256, manifestSha256: metadata.manifestSha256 }, signal);
        current.stream.destroy();
        requireV6SealAdmission(runtime.admission, runtime.input, point, current.manifest);
        const staging = path.join(this.root(), 'staging');
        await privateBackupDirectory(staging);
        const admitted = await admitRuntimeFile({
          source: runtimeTemporary,
          stagingParent: staging,
          passphrase: await this.unwrap(point),
          expected: runtimeExpectation,
          signal,
          maximumBytes: runtimePayloadLimits.plaintextBytes,
          timeoutMs: 300_000,
        });
        try {
          if (
            admitted.manifest.schema !== 'orbis.time-machine-runtime.v6' ||
            !admitted.appRuntime ||
            !runtime.input.appRuntime ||
            !admitted.appRuntime.read().equals(runtime.input.appRuntime.read()) ||
            !admitted.coherence ||
            !runtime.input.coherence ||
            admitted.coherence.database.sha256 !== runtime.input.coherence.database.sha256 ||
            admitted.coherence.database.bytes !== runtime.input.coherence.database.bytes
          )
            throw timeMachineConflict('point-integrity-failed');
          await reviewV6SealArchive(runtime.admission, runtime.input, point, temporary, admitted.capture, archiveSha256, signal);
        } finally {
          await admitted.dispose();
        }
      }
      const completed = timeMachineMetadataSchema.assert({
        ...metadata,
        archiveBytes: bytes,
        archiveSha256,
        ...(runtimeSummary ? { runtime: runtimeSummary } : {}),
      });
      if (completed.id !== point.id || completed.createdAt !== point.createdAt) throw timeMachineConflict('point-integrity-failed');
      if (Buffer.byteLength(JSON.stringify(completed)) > timeMachineLimits.metadataBytes) throw timeMachineConflict('capacity-exceeded');
      const json = JSON.stringify(runtimeExpectation ? { version: 'runtime-expectation-v1', metadata: completed, runtimeExpectation } : completed);
      const encryptedMetadata = await backupMetadataBytes(
        Buffer.from(json),
        await this.unwrap(point),
        false,
        timeMachineLimits.metadataBytes + runtimePayloadLimits.metadataBytes + 65536,
      );
      signal.throwIfAborted();
      await this.atomic(sealedMetadata, encryptedMetadata, false);
      linked.push(sealedMetadata);
      const metadataSha256 = createHash('sha256').update(encryptedMetadata).digest('hex');
      await fs.link(temporary, path.join(directory, 'backup.orbis'));
      linked.push(path.join(directory, 'backup.orbis'));
      if (runtimeSummary) {
        await fs.link(runtimeTemporary, path.join(directory, 'runtime.orbis'));
        linked.push(path.join(directory, 'runtime.orbis'));
      }
      await fs.rm(temporary);
      await this.sync(directory);
      await this.update({
        ...point,
        status: 'sealed',
        archiveBytes: bytes,
        archiveSha256,
        metadataSha256,
        assetBytes,
        issue: null,
        ...(runtimeSummary
          ? {
              runtimeBytes: runtimeSummary.cipherBytes,
              runtimeCipherSha256: runtimeSummary.cipherSha256,
              runtimeManifestSha256: runtimeSummary.manifestSha256,
              imageCaptureSha256: runtimeSummary.imageCaptureSha256,
              imageInventorySha256: runtimeSummary.imageInventorySha256,
              configurationSetSha256: runtimeSummary.configurationSetSha256,
            }
          : {}),
      } as StoredTimeMachinePoint);
      return completed;
    } catch (error) {
      // Never remove a potentially committed sealed generation after an ambiguous directory-sync failure.
      if ((await this.load(point.id).catch(() => undefined))?.status !== 'sealed') for (const file of linked) await fs.rm(file, { force: true });
      throw error;
    } finally {
      source.destroy();
      await output?.close();
      await fs.rm(temporary, { force: true });
      await fs.rm(runtimeTemporary, { force: true });
    }
  }
  private async metadataRecord(point: StoredTimeMachinePoint) {
    if (point.status !== 'sealed' || !point.metadataSha256) throw timeMachineConflict('point-not-found');
    const directory = this.pointDirectory(point.id);
    const source = path.join(directory, 'metadata.orbis');
    const maximum = timeMachineLimits.metadataBytes + runtimePayloadLimits.metadataBytes + 65536;
    const ciphertext = await this.read(source, maximum + 52);
    if (createHash('sha256').update(ciphertext).digest('hex') !== point.metadataSha256) throw timeMachineConflict('point-integrity-failed');
    const record: unknown = JSON.parse((await backupMetadataBytes(ciphertext, await this.unwrap(point), true, maximum)).toString());
    const wrapped =
      record && typeof record === 'object' && 'version' in record && record.version === 'runtime-expectation-v1'
        ? (record as unknown as { metadata: unknown; runtimeExpectation: RuntimeAdmissionExpectation })
        : null;
    const parsed = wrapped ? wrapped.metadata : record;
    if (
      !timeMachineMetadataSchema.allows(parsed) ||
      parsed.id !== point.id ||
      parsed.createdAt !== point.createdAt ||
      parsed.archiveBytes !== point.archiveBytes ||
      parsed.archiveSha256 !== point.archiveSha256
    )
      throw timeMachineConflict('point-integrity-failed');
    const expectedAssetBytes = parsed.preview.available
      ? (parsed.preview.wallpaperAsset.available ? parsed.preview.wallpaperAsset.bytes + 52 : 0) +
        (parsed.preview.appIcons ? parsed.preview.appIcons.bytes + 52 : 0)
      : 0;
    if ((point.assetBytes ?? 0) !== expectedAssetBytes) throw timeMachineConflict('point-integrity-failed');
    if (parsed.version !== point.version) throw timeMachineConflict('point-integrity-failed');
    if (point.version === 2 && parsed.version === 2) {
      const runtime = parsed.runtime;
      if (
        runtime.cipherBytes !== point.runtimeBytes ||
        runtime.cipherSha256 !== point.runtimeCipherSha256 ||
        runtime.manifestSha256 !== point.runtimeManifestSha256 ||
        runtime.imageCaptureSha256 !== point.imageCaptureSha256 ||
        runtime.imageInventorySha256 !== point.imageInventorySha256 ||
        runtime.configurationSetSha256 !== point.configurationSetSha256
      )
        throw timeMachineConflict('point-integrity-failed');
      const stat = await fs.lstat(path.join(directory, 'runtime.orbis'));
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== point.runtimeBytes ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw timeMachineConflict('point-integrity-failed');
    }
    return { metadata: parsed, runtimeExpectation: wrapped?.runtimeExpectation };
  }
  async metadata(point: StoredTimeMachinePoint): Promise<TimeMachineMetadata> {
    return (await this.metadataRecord(point)).metadata;
  }
  private async openVerifiedRuntime(point: StoredTimeMachinePoint, signal: AbortSignal) {
    const { metadata, runtimeExpectation } = await this.metadataRecord(point);
    if (point.version !== 2 || metadata.version !== 2 || !runtimeExpectation || runtimeExpectation.manifestSha256 !== metadata.runtime.manifestSha256)
      throw timeMachineConflict('point-integrity-failed');
    const staging = path.join(this.root(), 'staging');
    await privateBackupDirectory(staging);
    const admitted = await admitRuntimeFile({
      source: path.join(this.pointDirectory(point.id), 'runtime.orbis'),
      stagingParent: staging,
      passphrase: await this.unwrap(point),
      expected: runtimeExpectation,
      signal,
      maximumBytes: runtimePayloadLimits.plaintextBytes,
      timeoutMs: 300_000,
    });
    try {
      if (
        admitted.manifest.pointId !== point.id ||
        admitted.manifest.legacy.bytes !== metadata.archiveBytes ||
        admitted.manifest.legacy.cipherSha256 !== metadata.archiveSha256 ||
        admitted.manifest.legacy.manifestSha256 !== metadata.manifestSha256 ||
        (admitted.manifest.schema === 'orbis.time-machine-runtime.v3' ||
        admitted.manifest.schema === 'orbis.time-machine-runtime.v4' ||
        admitted.manifest.schema === 'orbis.time-machine-runtime.v6'
          ? admitted.manifest.coherenceSha256
          : undefined) !== metadata.runtime.coherenceSha256
      )
        throw timeMachineConflict('point-integrity-failed');
      return admitted;
    } catch (error) {
      await admitted.dispose();
      throw error;
    }
  }
  async verifyRuntime(point: StoredTimeMachinePoint, signal: AbortSignal) {
    const admitted = await this.openVerifiedRuntime(point, signal);
    try {
      return {
        capture: admitted.capture,
        coherence: admitted.coherence,
        controllerAuthority: admitted.controllerAuthority,
        appRuntime: admitted.appRuntime,
      };
    } finally {
      await admitted.dispose();
    }
  }
  async requireCoherentRuntime(point: StoredTimeMachinePoint, signal: AbortSignal) {
    const admitted = await this.openVerifiedRuntime(point, signal);
    if (!admitted.coherence || !admitted.controllerAuthority) {
      await admitted.dispose();
      throw timeMachineConflict('point-integrity-failed');
    }
    return { ...admitted, coherence: admitted.coherence, controllerAuthority: admitted.controllerAuthority };
  }
  async verifyArchive(point: StoredTimeMachinePoint, signal?: AbortSignal) {
    if (point.status !== 'sealed' || !point.archiveSha256 || point.archiveBytes < 52 || point.archiveBytes > timeMachineLimits.bytes)
      throw timeMachineConflict('point-integrity-failed');
    const file = path.join(this.pointDirectory(point.id), 'backup.orbis');
    await this.directory(path.dirname(file));
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== point.archiveBytes ||
        stat.mode & 0o077 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw timeMachineConflict('point-integrity-failed');
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
      if (hash.digest('hex') !== point.archiveSha256 || !sameStat(stat, await handle.stat())) throw timeMachineConflict('point-integrity-failed');
      if (point.version === 2) {
        const runtime = await fs.open(
          path.join(this.pointDirectory(point.id), 'runtime.orbis'),
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        try {
          const before = await runtime.stat();
          if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.size !== point.runtimeBytes ||
            before.mode & 0o077 ||
            (process.getuid && before.uid !== process.getuid())
          )
            throw timeMachineConflict('point-integrity-failed');
          const digest = createHash('sha256');
          for await (const chunk of runtime.createReadStream({ autoClose: false, signal })) digest.update(chunk);
          if (digest.digest('hex') !== point.runtimeCipherSha256 || !sameStat(before, await runtime.stat()))
            throw timeMachineConflict('point-integrity-failed');
        } finally {
          await runtime.close();
        }
      }
      return stat;
    } finally {
      await handle.close();
    }
  }
  async machineIdentity(create = false) {
    const file = path.join(this.root(), 'keys', 'machine-v1.id');
    let id: string;
    try {
      id = (await this.read(file, 64)).toString();
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await this.atomic(file, randomUUID(), false);
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
      }
      id = (await this.read(file, 64)).toString();
    }
    if (!timeMachineIdSchema.allows(id)) throw timeMachineConflict('storage-unavailable');
    return createHash('sha256').update(`orbis-time-machine-machine-v1\n${id}`).digest('hex');
  }
  async withArchive<T>(
    point: StoredTimeMachinePoint,
    signal: AbortSignal,
    consume: (source: Readable, passphrase: string) => Promise<T>,
  ): Promise<T> {
    const proof = await this.verifyArchive(point, signal);
    const file = path.join(this.pointDirectory(point.id), 'backup.orbis');
    await this.directory(path.dirname(file));
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let source: ReturnType<FileHandle['createReadStream']> | undefined;
    try {
      if (!sameStat(proof, await handle.stat())) throw timeMachineConflict('point-integrity-failed');
      signal.throwIfAborted();
      source = handle.createReadStream({ autoClose: false, start: 0, end: point.archiveBytes - 1, signal });
      source.on('error', () => undefined);
      const result = await consume(source, await this.unwrap(point));
      if (!source.readableEnded || source.bytesRead !== point.archiveBytes || !sameStat(proof, await handle.stat()))
        throw timeMachineConflict('point-integrity-failed');
      signal.throwIfAborted();
      return result;
    } finally {
      source?.destroy();
      await handle.close();
    }
  }
  async retainAppIcons(point: StoredTimeMachinePoint, icons: CapturedAppIcons, signal: AbortSignal): Promise<HistoricalIconsAsset> {
    if ((await this.load(point.id)).status !== 'capturing') throw timeMachineConflict('point-integrity-failed');
    verifyAppIcons(icons.data, { ...icons, bytes: icons.data.length });
    const space = await fs.statfs(this.pointDirectory(point.id));
    if (space.bavail * space.bsize < icons.data.length + 256 * 1024 * 1024) throw timeMachineConflict('capacity-exceeded');
    try {
      const encrypted = await backupMetadataBytes(icons.data, await this.unwrap(point), false, historicalIconLimits.bundleBytes);
      signal.throwIfAborted();
      await this.atomic(path.join(this.pointDirectory(point.id), 'icons.orbis'), encrypted, false);
      return historicalIconsAssetSchema.assert({
        available: true,
        identity: icons.identity,
        icons: icons.icons,
        bytes: icons.data.length,
        cipherSha256: createHash('sha256').update(encrypted).digest('hex'),
      });
    } finally {
      icons.data.fill(0);
    }
  }
  async appIcons(point: StoredTimeMachinePoint, asset: HistoricalIconsAsset) {
    const encrypted = await this.read(path.join(this.pointDirectory(point.id), 'icons.orbis'), historicalIconLimits.bundleBytes + 52);
    if (encrypted.length !== asset.bytes + 52 || createHash('sha256').update(encrypted).digest('hex') !== asset.cipherSha256)
      throw timeMachineConflict('point-integrity-failed');
    const data = await backupMetadataBytes(encrypted, await this.unwrap(point), true, historicalIconLimits.bundleBytes);
    verifyAppIcons(data, asset);
    return data;
  }
  async retainWallpaper(point: StoredTimeMachinePoint, wallpaper: CapturedWallpaper, signal: AbortSignal): Promise<TimeMachineWallpaperAsset> {
    if ((await this.load(point.id)).status !== 'capturing') throw timeMachineConflict('point-integrity-failed');
    const checked = capturedWallpaper(wallpaper.data, wallpaper.source, wallpaper.identity);
    const space = await fs.statfs(this.pointDirectory(point.id));
    if (space.bavail * space.bsize < checked.bytes + 256 * 1024 * 1024) throw timeMachineConflict('capacity-exceeded');
    const encrypted = await backupMetadataBytes(checked.data, await this.unwrap(point), false, timeMachineAssetLimit);
    signal.throwIfAborted();
    await this.atomic(path.join(this.pointDirectory(point.id), 'wallpaper.orbis'), encrypted, false);
    const { data: _data, ...metadata } = checked;
    return timeMachineWallpaperAssetSchema.assert({
      ...metadata,
      available: true,
      cipherSha256: createHash('sha256').update(encrypted).digest('hex'),
    });
  }
  async wallpaper(point: StoredTimeMachinePoint, asset: TimeMachineWallpaperAsset) {
    const encrypted = await this.read(path.join(this.pointDirectory(point.id), 'wallpaper.orbis'), timeMachineAssetLimit + 52);
    if (encrypted.length !== asset.bytes + 52 || createHash('sha256').update(encrypted).digest('hex') !== asset.cipherSha256)
      throw timeMachineConflict('point-integrity-failed');
    const data = await backupMetadataBytes(encrypted, await this.unwrap(point), true, timeMachineAssetLimit);
    const checked = capturedWallpaper(data, asset.source, asset.identity);
    if (checked.bytes !== asset.bytes || checked.mime !== asset.mime || checked.width !== asset.width || checked.height !== asset.height)
      throw timeMachineConflict('point-integrity-failed');
    return { data, mime: asset.mime };
  }
  remove(id: string, ownerId: number) {
    return this.serialize(async () => {
      const point = await this.load(id);
      if (point.ownerId !== ownerId) throw timeMachineConflict('point-not-found');
      if (point.status === 'capturing') throw timeMachineConflict('operation-busy');
      await this.directory(this.pointDirectory(id));
      await fs.rm(this.pointDirectory(id), { recursive: true });
      await this.sync(path.join(this.root(), 'points'));
      return { removed: true as const };
    });
  }
  async fail(point: StoredTimeMachinePoint, issue: TimeMachineReason) {
    await this.update({ ...point, status: issue === 'capture-interrupted' ? 'interrupted' : 'failed', issue });
    for (const name of [
      'backup.orbis',
      'metadata.orbis',
      'metadata.partial.json',
      'archive.partial',
      'wallpaper.orbis',
      'icons.orbis',
      'runtime.orbis',
      'runtime.partial',
    ])
      await fs.rm(path.join(this.pointDirectory(point.id), name), { force: true });
  }
}

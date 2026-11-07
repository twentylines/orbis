import { historicalIconLimits, historicalIconsAssetSchema, type HistoricalIconsAsset } from '@runtipi/common/schemas/time-machine-icons';
import { verifyAppIcons, type CapturedAppIcons } from './time-machine-app-icons';
import { coreCapturePointReservationSha256 } from './time-machine-core-reservation';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { type } from 'arktype';
import {
  defaultTimeMachinePreferences,
  timeMachineIdSchema,
  timeMachineHashSchema,
  timeMachineLimits,
  timeMachineAssetLimit,
  timeMachineWallpaperAssetSchema,
  timeMachineMetadataSchema,
  timeMachineCoreMetadataSchema,
  timeMachineCoreSummarySchema,
  timeMachinePreferencesSchema,
  timeMachineReasonSchema,
  type TimeMachineMetadata,
  type TimeMachinePreferences,
  type TimeMachinePreferencesUpdate,
  type TimeMachineReason,
  type TimeMachineWallpaperAsset,
  type TimeMachineRuntimeSummary,
  type TimeMachineCoreMetadata,
} from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, encryptBackupStream, backupCipherOverhead } from './backup-crypto';
import { runtimePayload, runtimePayloadLimits, type CapturedRuntimeInput } from './time-machine-runtime-payload';
import { admitRuntimeFile, type RuntimeAdmissionExpectation } from './time-machine-runtime-reader';
import { privateBackupDirectory } from './backup-files';
import { timeMachineConflict } from './time-machine-policy';
import { capturedWallpaper, type CapturedWallpaper } from './time-machine-assets';
import type { V6SealAdmission } from './time-machine-v6-seal-admission';
import type { CoreCatalogPublication } from './time-machine-core-catalog-worker';
import { withVerifiedCapsuleContents, type VerifiedCapsuleContents, type VerifiedCapsuleBinding } from '../time-machine-capsules/verify';
import { inspectCapsuleEntry } from '../time-machine-capsules/verified-source';
import { withCorePayload, type VerifiedCorePayload } from './time-machine-core-payload';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';

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
const coreStoredPointSchema = legacyStoredPointSchema
  .omit('version')
  .merge({
    version: '3',
    kind: "'orbis-core'",
    coreFormat: "'orbis.time-machine-core.v1'",
    core: timeMachineCoreSummarySchema.or('null'),
  })
  .onUndeclaredKey('reject')
  .narrow((point) =>
    point.status === 'sealed'
      ? point.core !== null &&
        point.metadataSha256 !== null &&
        point.core.cipherBytes === point.archiveBytes &&
        point.core.cipherSha256 === point.archiveSha256
      : point.core === null && point.archiveBytes === 0 && point.archiveSha256 === null && point.metadataSha256 === null,
  );
const storedPointSchema = legacyStoredPointSchema.or(runtimeStoredPointSchema).or(coreStoredPointSchema);
const portableImportMarkerSchema = type({
  version: '1',
  operationId: timeMachineIdSchema,
  ownerId: 'number.integer > 0',
  pointId: timeMachineIdSchema,
  archiveSha256: timeMachineHashSchema,
  metadataSha256: timeMachineHashSchema,
}).onUndeclaredKey('reject');
export type StoredTimeMachinePoint = typeof storedPointSchema.infer;
type StoredLegacyTimeMachinePoint = typeof legacyStoredPointSchema.infer | typeof runtimeStoredPointSchema.infer;
export type StoredCoreTimeMachinePoint = typeof coreStoredPointSchema.infer;
type Draft<T> = T extends unknown ? Omit<T, 'archiveBytes' | 'archiveSha256' | 'runtime'> : never;
export type TimeMachineDraftMetadata = Draft<TimeMachineMetadata>;
export type TimeMachineCoreDraftMetadata = Omit<TimeMachineCoreMetadata, 'archiveBytes' | 'archiveSha256' | 'manifestSha256' | 'core'>;
const sameStat = (first: Awaited<ReturnType<FileHandle['stat']>>, second: Awaited<ReturnType<FileHandle['stat']>>) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));
const sameCoreDataStat = (first: Awaited<ReturnType<FileHandle['stat']>>, second: Awaited<ReturnType<FileHandle['stat']>>) =>
  ['ino', 'dev', 'size', 'mode', 'nlink', 'uid', 'gid', 'mtimeMs'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));

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
  private async portableStorageParents() {
    const parent = await fs.lstat(this.dataDir);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (await fs.realpath(this.dataDir)) !== path.resolve(this.dataDir))
      throw timeMachineConflict('storage-unavailable');
    for (const directory of [
      path.join(this.dataDir, 'backups'),
      this.root(),
      ...['points', 'keys', 'portable-staging'].map((name) => path.join(this.root(), name)),
    ]) {
      try {
        await this.directory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
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
  /** Caller holds global backup maintenance and disk leases through publication; this method does not acquire them. */
  importPortablePoint(
    ownerId: number,
    token: VerifiedCapsuleContents,
    signal: AbortSignal,
    operationId?: string,
  ): Promise<{ point: StoredTimeMachinePoint; created: boolean }> {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(ownerId) || ownerId < 1 || (operationId !== undefined && !timeMachineIdSchema.allows(operationId)))
        throw timeMachineConflict('invalid-request');
      return withVerifiedCapsuleContents(token, signal, async (verified) => {
        await this.portableStorageParents();
        const { manifest, metadata } = verified;
        if (metadata.version !== 2) throw timeMachineConflict('point-integrity-failed');
        const metadataEntry = manifest.entries.find((entry) => entry.name === 'metadata.orbis');
        if (!metadataEntry) throw timeMachineConflict('point-integrity-failed');
        const assetBytes = manifest.entries
          .filter((entry) => entry.name === 'wallpaper.orbis' || entry.name === 'icons.orbis')
          .reduce((sum, entry) => sum + entry.bytes, 0);
        const identity = {
          version: 2 as const,
          id: metadata.id,
          ownerId,
          createdAt: metadata.createdAt,
          status: 'sealed' as const,
          backupJobId: null,
          issue: null,
          archiveBytes: metadata.archiveBytes,
          archiveSha256: metadata.archiveSha256,
          metadataSha256: metadataEntry.sha256,
          assetBytes,
          runtimeBytes: metadata.runtime.cipherBytes,
          runtimeCipherSha256: metadata.runtime.cipherSha256,
          runtimeManifestSha256: metadata.runtime.manifestSha256,
          imageCaptureSha256: metadata.runtime.imageCaptureSha256,
          imageInventorySha256: metadata.runtime.imageInventorySha256,
          configurationSetSha256: metadata.runtime.configurationSetSha256,
        };
        const names = [...manifest.entries.map((entry) => entry.name), 'point.json'].sort().join(',');
        const checkContents = async (point: StoredTimeMachinePoint, directory: string) => {
          await this.directory(directory);
          const stored = storedPointSchema.assert(JSON.parse((await this.read(path.join(directory, 'point.json'), 32_768)).toString()));
          if (JSON.stringify(stored) !== JSON.stringify(point)) throw timeMachineConflict('point-integrity-failed');
          const contents = await fs.readdir(directory);
          if (
            contents
              .filter((name) => name !== 'portable-import.json')
              .sort()
              .join(',') !== names
          )
            throw timeMachineConflict('point-integrity-failed');
          if (contents.includes('portable-import.json')) await this.portableImportMarker(point, directory);
          for (const entry of manifest.entries) await inspectCapsuleEntry(directory, entry, signal);
          const record = await this.metadataRecord(point, directory);
          if (
            JSON.stringify(record.metadata) !== JSON.stringify(metadata) ||
            JSON.stringify(record.runtimeExpectation) !== JSON.stringify(verified.runtimeExpectation)
          )
            throw timeMachineConflict('point-integrity-failed');
        };
        const points = await this.list();
        const existing = points.find((point) => point.id === metadata.id);
        if (existing) {
          if (
            existing.ownerId !== ownerId ||
            existing.status !== 'sealed' ||
            Object.entries(identity).some(([key, value]) => !['backupJobId', 'issue'].includes(key) && Reflect.get(existing, key) !== value) ||
            (await this.unwrap(existing)) !== manifest.pointKey
          )
            throw timeMachineConflict('point-integrity-failed');
          await checkContents(existing, this.pointDirectory(existing.id));
          await verified.recheck(signal);
          return { point: existing, created: false };
        }
        const incoming = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0);
        const retained = points.reduce(
          (sum, point) =>
            sum + point.archiveBytes + (point.assetBytes ?? 0) + (point.version === 2 ? point.runtimeBytes : 0) + timeMachineLimits.metadataBytes,
          0,
        );
        let filesystem = this.root();
        for (;;) {
          try {
            await fs.lstat(filesystem);
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || filesystem === path.resolve(this.dataDir)) throw error;
            filesystem = path.dirname(filesystem);
          }
        }
        const space = await fs.statfs(filesystem, { bigint: true });
        if (
          points.length >= timeMachineLimits.points ||
          retained + incoming > timeMachineLimits.bytes ||
          space.bavail * space.bsize < BigInt(incoming + 256 * 1024 * 1024 + 32_768)
        )
          throw timeMachineConflict('capacity-exceeded');
        if (points.length) {
          const key = await this.masterKey(false);
          try {
            const keyId = createHash('sha256').update(key).digest('hex');
            if (points.some((point) => point.envelope.keyId !== keyId)) throw timeMachineConflict('point-integrity-failed');
          } finally {
            key.fill(0);
          }
        }
        signal.throwIfAborted();
        const stagingParent = path.join(this.root(), 'portable-staging');
        await this.directory(stagingParent, true);
        const staging = await fs.mkdtemp(path.join(stagingParent, 'import-'));
        await fs.chmod(staging, 0o700);
        // Failed or ambiguously published generations remain private evidence outside points/.
        await verified.copyTo(staging, signal);
        const point = storedPointSchema.assert({ ...identity, envelope: await this.wrap(metadata.id, ownerId, manifest.pointKey) });
        await this.atomic(path.join(staging, 'point.json'), JSON.stringify(point), false);
        if (operationId)
          await this.atomic(
            path.join(staging, 'portable-import.json'),
            JSON.stringify({
              version: 1,
              operationId,
              ownerId,
              pointId: point.id,
              archiveSha256: point.archiveSha256,
              metadataSha256: point.metadataSha256,
            }),
            false,
          );
        await checkContents(point, staging);
        await verified.recheck(signal);
        await this.sync(staging);
        const destination = this.pointDirectory(point.id);
        const parent = path.dirname(destination);
        await this.directory(parent, true);
        try {
          await fs.lstat(destination);
          throw timeMachineConflict('point-integrity-failed');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        signal.throwIfAborted();
        await fs.rename(staging, destination);
        await this.sync(parent);
        await this.sync(stagingParent);
        return { point, created: true };
      });
    });
  }
  private async portableImportMarker(point: StoredTimeMachinePoint, directory: string) {
    const marker = portableImportMarkerSchema.assert(JSON.parse((await this.read(path.join(directory, 'portable-import.json'), 4096)).toString()));
    if (
      !Number.isSafeInteger(marker.ownerId) ||
      marker.ownerId !== point.ownerId ||
      marker.pointId !== point.id ||
      marker.archiveSha256 !== point.archiveSha256 ||
      marker.metadataSha256 !== point.metadataSha256
    )
      throw timeMachineConflict('point-integrity-failed');
    return marker;
  }
  /** Removes only this operation's verified library publication. Caller holds maintenance and disk leases. */
  removePortableImport(ownerId: number, operationId: string, binding: VerifiedCapsuleBinding, signal: AbortSignal): Promise<{ removed: boolean }> {
    return this.serialize(async () => {
      if (
        !Number.isSafeInteger(ownerId) ||
        ownerId < 1 ||
        !timeMachineIdSchema.allows(operationId) ||
        !binding ||
        !timeMachineIdSchema.allows(binding.pointId) ||
        !Number.isSafeInteger(binding.createdAt) ||
        binding.createdAt < 1 ||
        !timeMachineHashSchema.allows(binding.archiveSha256) ||
        !timeMachineHashSchema.allows(binding.metadataSha256)
      )
        throw timeMachineConflict('invalid-request');
      signal.throwIfAborted();
      await this.portableStorageParents();
      const directory = this.pointDirectory(binding.pointId);
      let before: Awaited<ReturnType<typeof fs.lstat>>;
      try {
        before = await fs.lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false };
        throw error;
      }
      await this.directory(directory);
      const point = await this.load(binding.pointId);
      if (
        point.version !== 2 ||
        point.status !== 'sealed' ||
        point.ownerId !== ownerId ||
        point.createdAt !== binding.createdAt ||
        point.archiveSha256 !== binding.archiveSha256 ||
        point.metadataSha256 !== binding.metadataSha256
      )
        throw timeMachineConflict('point-integrity-failed');
      const marker = await this.portableImportMarker(point, directory);
      if (marker.operationId !== operationId) throw timeMachineConflict('point-integrity-failed');
      const metadata = await this.metadata(point);
      const expectedNames = ['point.json', 'portable-import.json', 'backup.orbis', 'metadata.orbis', 'runtime.orbis'];
      if (metadata.preview.available && metadata.preview.wallpaperAsset.available) {
        expectedNames.push('wallpaper.orbis');
        const wallpaper = await this.wallpaper(point, metadata.preview.wallpaperAsset);
        wallpaper.data.fill(0);
      }
      if (metadata.preview.available && metadata.preview.appIcons) {
        expectedNames.push('icons.orbis');
        (await this.appIcons(point, metadata.preview.appIcons)).fill(0);
      }
      if ((await fs.readdir(directory)).sort().join(',') !== expectedNames.sort().join(',')) throw timeMachineConflict('point-integrity-failed');
      await this.verifyArchive(point, signal);
      for (const name of ['point.json', 'portable-import.json']) {
        const file = path.join(directory, name);
        const stat = await fs.lstat(file);
        await this.read(file, name === 'point.json' ? 32_768 : 4096);
        if (!sameStat(stat, await fs.lstat(file))) throw timeMachineConflict('point-integrity-failed');
      }
      if (
        JSON.stringify(await this.load(point.id)) !== JSON.stringify(point) ||
        (await this.portableImportMarker(point, directory)).operationId !== operationId ||
        !sameStat(before, await fs.lstat(directory))
      )
        throw timeMachineConflict('point-integrity-failed');
      const stagingParent = path.join(this.root(), 'portable-staging');
      await this.directory(stagingParent, true);
      signal.throwIfAborted();
      const retired = path.join(stagingParent, `rollback-${randomUUID()}`);
      await fs.rename(directory, retired);
      await this.sync(path.dirname(directory));
      await this.sync(stagingParent);
      const after = await fs.lstat(retired);
      if (['dev', 'ino', 'mode', 'uid'].some((key) => Reflect.get(before, key) !== Reflect.get(after, key)))
        throw timeMachineConflict('point-integrity-failed');
      await fs.rm(retired, { recursive: true });
      await this.sync(stagingParent);
      return { removed: true };
    });
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
      Object.keys(value).sort().join(',') !==
        (value && typeof value === 'object' && 'version' in value && value.version === 2
          ? 'id,machineId,ownerId,pointReservationSha256,state,version'
          : 'id,machineId,ownerId,state,version') ||
      !('id' in value && 'ownerId' in value && 'machineId' in value && 'state' in value && 'version' in value) ||
      (value.version !== 1 && value.version !== 2) ||
      value.id !== id ||
      value.ownerId !== ownerId ||
      value.machineId !== machineId ||
      (value.state !== 'reserved' && value.state !== 'ready') ||
      (value.version === 2 &&
        (value.state !== 'ready' || !('pointReservationSha256' in value) || !timeMachineHashSchema.allows(value.pointReservationSha256)))
    )
      throw timeMachineConflict('point-not-found');
    return {
      claimed,
      state: value.state,
      pointReservationSha256: value.version === 2 && 'pointReservationSha256' in value ? (value.pointReservationSha256 as string) : undefined,
    };
  }

  async readyOnboardingAttempt(id: string, ownerId: number) {
    const current = await this.onboardingAttempt(id, ownerId);
    if (current.state !== 'reserved') throw timeMachineConflict('capture-recovery-required');
    const machineId = await this.machineIdentity();
    const point = await this.load(id);
    if (point.ownerId !== ownerId) throw timeMachineConflict('point-not-found');
    const file = path.join(this.root(), 'onboarding-attempts', `${id}.json`);
    await this.atomic(
      file,
      JSON.stringify({
        version: point.version === 3 ? 2 : 1,
        id,
        ownerId,
        machineId,
        state: 'ready',
        ...(point.version === 3 ? { pointReservationSha256: coreCapturePointReservationSha256(point) } : {}),
      }),
      true,
    );
  }

  create(ownerId: number, version: 3, onboardingAttemptId?: string): Promise<{ point: StoredCoreTimeMachinePoint; passphrase: string }>;
  create(ownerId: number, version?: 1 | 2, onboardingAttemptId?: string): Promise<{ point: StoredLegacyTimeMachinePoint; passphrase: string }>;
  create(ownerId: number, version: 1 | 2 | 3 = 1, onboardingAttemptId?: string) {
    return this.serialize(async () => {
      if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw timeMachineConflict('invalid-request');
      if (onboardingAttemptId !== undefined && (version === 1 || !timeMachineIdSchema.allows(onboardingAttemptId)))
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
        ...(onboardingAttemptId && version === 2 ? { onboardingAttemptId } : {}),
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
        ...(version === 3 ? { kind: 'orbis-core', coreFormat: 'orbis.time-machine-core.v1', core: null } : {}),
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
      if (point.version === 3 || metadata.version === 3) throw timeMachineConflict('point-integrity-failed');
      if ((await this.load(point.id)).status !== 'capturing' || !Number.isSafeInteger(bytes) || bytes < 52)
        throw timeMachineConflict('point-integrity-failed');
      if (point.version !== metadata.version || (point.version === 2) !== Boolean(runtime)) throw timeMachineConflict('point-integrity-failed');
      const planned = runtime
        ? runtimePayload(runtime.input, { bytes, cipherSha256: '0'.repeat(64), manifestSha256: metadata.manifestSha256 }, signal)
        : null;
      planned?.stream.destroy();
      if (planned?.manifest.schema === 'orbis.time-machine-runtime.v6' && runtime)
        (await import('./time-machine-v6-seal-admission')).requireV6SealAdmission(runtime.admission, runtime.input, point, planned.manifest);
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
            (await import('./time-machine-v6-seal-admission')).requireV6SealAdmission(runtime.admission, runtime.input, point, payload.manifest);
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
        (await import('./time-machine-v6-seal-admission')).requireV6SealAdmission(runtime.admission, runtime.input, point, current.manifest);
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
          await (await import('./time-machine-v6-seal-admission')).reviewV6SealArchive(
            runtime.admission,
            runtime.input,
            point,
            temporary,
            admitted.capture,
            archiveSha256,
            signal,
          );
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
  private validateCoreDraft(point: StoredCoreTimeMachinePoint, draft: unknown): TimeMachineCoreDraftMetadata {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw timeMachineConflict('point-integrity-failed');
    for (const field of ['archiveBytes', 'archiveSha256', 'manifestSha256', 'core']) {
      if (Object.hasOwn(draft, field)) throw timeMachineConflict('point-integrity-failed');
    }
    const hash = '0'.repeat(64);
    const complete = {
      ...draft,
      archiveBytes: 52,
      archiveSha256: hash,
      manifestSha256: hash,
      core: {
        version: 1,
        format: 'orbis.time-machine-core.v1',
        cipherBytes: 52,
        cipherSha256: hash,
        manifestSha256: hash,
        sourceSha256: hash,
        checkpointSha256: hash,
        captureReceiptSha256: hash,
        imageInventorySha256: hash,
        imageCount: 1,
        resourceCount: 1,
      },
    };
    if (!timeMachineCoreMetadataSchema.allows(complete) || complete.id !== point.id || complete.createdAt !== point.createdAt)
      throw timeMachineConflict('point-integrity-failed');
    const { archiveBytes: _bytes, archiveSha256: _archive, manifestSha256: _manifest, core: _core, ...validated } = complete;
    return validated;
  }

  private async checkCoreDraftPoint(point: StoredCoreTimeMachinePoint, signal: AbortSignal, creating: boolean) {
    signal.throwIfAborted();
    if (!coreStoredPointSchema.allows(point) || (creating ? point.status !== 'capturing' : !['capturing', 'sealed'].includes(point.status)))
      throw timeMachineConflict('point-integrity-failed');
    const current = await this.load(point.id);
    signal.throwIfAborted();
    if (canonicalPublicationJson(current) !== canonicalPublicationJson(point)) throw timeMachineConflict('point-integrity-failed');
  }

  private async checkCoreDraftAssets(point: StoredCoreTimeMachinePoint, draft: TimeMachineCoreDraftMetadata, signal: AbortSignal) {
    signal.throwIfAborted();
    if (draft.preview.available) {
      if (draft.preview.wallpaperAsset.available) {
        const wallpaper = await this.wallpaper(point, draft.preview.wallpaperAsset);
        wallpaper.data.fill(0);
        signal.throwIfAborted();
      }
      if (draft.preview.appIcons) {
        (await this.appIcons(point, draft.preview.appIcons)).fill(0);
        signal.throwIfAborted();
      }
    }
  }

  async readCoreDraft(point: StoredCoreTimeMachinePoint, signal: AbortSignal): Promise<TimeMachineCoreDraftMetadata> {
    await this.checkCoreDraftPoint(point, signal, false);
    const ciphertext = await this.read(path.join(this.pointDirectory(point.id), 'capture-draft.orbis'), timeMachineLimits.metadataBytes + 52);
    signal.throwIfAborted();
    const plaintext = await backupMetadataBytes(ciphertext, await this.unwrap(point), true, timeMachineLimits.metadataBytes);
    signal.throwIfAborted();
    let record: unknown;
    try {
      record = JSON.parse(plaintext.toString());
    } finally {
      plaintext.fill(0);
    }
    if (
      !record ||
      typeof record !== 'object' ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(',') !== 'binding,draft,version' ||
      !('version' in record) ||
      record.version !== 1 ||
      !('binding' in record) ||
      !('draft' in record) ||
      canonicalPublicationJson(record.binding) !==
        canonicalPublicationJson({ id: point.id, ownerId: point.ownerId, createdAt: point.createdAt, envelope: point.envelope })
    )
      throw timeMachineConflict('point-integrity-failed');
    const draft = this.validateCoreDraft(point, record.draft);
    await this.checkCoreDraftAssets(point, draft, signal);
    await this.checkCoreDraftPoint(point, signal, false);
    return draft;
  }

  saveCoreDraft(point: StoredCoreTimeMachinePoint, draft: TimeMachineCoreDraftMetadata, signal: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      await this.checkCoreDraftPoint(point, signal, true);
      const validated = this.validateCoreDraft(point, structuredClone(this.validateCoreDraft(point, draft)));
      await this.checkCoreDraftAssets(point, validated, signal);
      const binding = { id: point.id, ownerId: point.ownerId, createdAt: point.createdAt, envelope: point.envelope };
      const plaintext = Buffer.from(JSON.stringify({ version: 1, binding, draft: validated }));
      if (plaintext.length > timeMachineLimits.metadataBytes) throw timeMachineConflict('capacity-exceeded');
      let ciphertext: Buffer;
      try {
        ciphertext = await backupMetadataBytes(plaintext, await this.unwrap(point), false, timeMachineLimits.metadataBytes);
      } finally {
        plaintext.fill(0);
      }
      signal.throwIfAborted();
      await this.checkCoreDraftPoint(point, signal, true);
      try {
        await this.atomic(path.join(this.pointDirectory(point.id), 'capture-draft.orbis'), ciphertext, false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.readCoreDraft(point, signal);
        if (canonicalPublicationJson(existing) !== canonicalPublicationJson(validated)) throw timeMachineConflict('point-integrity-failed');
      }
      signal.throwIfAborted();
      await this.checkCoreDraftPoint(point, signal, true);
    });
  }

  adoptPublishedCorePoint(point: StoredCoreTimeMachinePoint, sourceDirectory: string, publication: CoreCatalogPublication, signal: AbortSignal) {
    return this.serialize(async () => {
      const fail = () => timeMachineConflict('point-integrity-failed');
      const json = canonicalPublicationJson;
      const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
      const destination = this.pointDirectory(point.id);
      const root = this.root();
      if (
        !path.isAbsolute(sourceDirectory) ||
        path.resolve(sourceDirectory) !== sourceDirectory ||
        !sourceDirectory.startsWith(`${root}/`) ||
        sourceDirectory === destination ||
        destination.startsWith(`${sourceDirectory}/`) ||
        sourceDirectory.startsWith(`${destination}/`) ||
        !coreStoredPointSchema.allows(point) ||
        !['capturing', 'sealed'].includes(point.status)
      )
        throw fail();
      const dirs = [this.dataDir, path.join(this.dataDir, 'backups'), root, path.join(root, 'points'), destination, path.join(root, 'keys')];
      for (let dir = sourceDirectory; dir !== root; dir = path.dirname(dir)) dirs.push(dir);
      const directorySeals = await Promise.all(
        [...new Set(dirs)].map(async (dir) => {
          const stat = await fs.lstat(dir);
          const shared = dir === this.dataDir || dir === path.join(this.dataDir, 'backups');
          if (
            !stat.isDirectory() ||
            stat.uid !== process.getuid?.() ||
            (shared ? (stat.mode & 0o7022) !== 0 : (stat.mode & 0o7777) !== 0o700) ||
            (await fs.realpath(dir)) !== dir
          )
            throw fail();
          return { dir, stat };
        }),
      );
      const checkDirectories = async () => {
        for (const { dir, stat } of directorySeals) {
          const current = await fs.lstat(dir);
          if (
            !['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(stat, key) === Reflect.get(current, key)) ||
            (await fs.realpath(dir)) !== dir
          )
            throw fail();
        }
      };
      const allowed = ['point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis', 'wallpaper.orbis', 'icons.orbis'];
      const fileNames = Object.keys(publication.files).sort();
      if (
        publication.schema !== 'orbis.core-capture-catalog-publication.v1' ||
        fileNames.some((name) => !allowed.includes(name)) ||
        !['point.json', 'metadata.orbis', 'core.orbis', 'capture-draft.orbis'].every((name) => fileNames.includes(name))
      )
        throw fail();
      const maxFor = (name: string) =>
        name === 'point.json'
          ? 32768
          : name === 'core.orbis'
            ? timeMachineLimits.bytes
            : name === 'wallpaper.orbis'
              ? timeMachineAssetLimit + 52
              : name === 'icons.orbis'
                ? historicalIconLimits.bundleBytes + 52
                : timeMachineLimits.metadataBytes + 52;
      for (const name of fileNames) {
        const entry = publication.files[name];
        if (!entry || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > maxFor(name) || !/^[a-f0-9]{64}$/.test(entry.sha256))
          throw fail();
      }
      // Hash through a no-follow descriptor and bind it to the pathname before and after reading.
      const verifiedFiles = new Set<string>();
      const inspect = async (file: string, name: string, links = 1) => {
        const before = await fs.lstat(file);
        if (
          !before.isFile() ||
          before.uid !== process.getuid?.() ||
          ![0o400, 0o600].includes(before.mode & 0o7777) ||
          before.nlink !== links ||
          before.size !== publication.files[name]?.bytes ||
          (await fs.realpath(file)) !== file
        )
          throw fail();
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          if (!sameStat(before, await handle.stat())) throw fail();
          const signature = json([
            name,
            publication.files[name]?.sha256,
            ...['dev', 'ino', 'size', 'mode', 'nlink', 'uid', 'gid', 'mtimeMs', 'ctimeMs'].map((key) => Reflect.get(before, key)),
          ]);
          if (!verifiedFiles.has(signature)) {
            const digest = createHash('sha256');
            const buffer = Buffer.alloc(64 * 1024);
            let offset = 0;
            while (offset < before.size) {
              signal.throwIfAborted();
              const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
              if (!bytesRead) throw fail();
              digest.update(buffer.subarray(0, bytesRead));
              offset += bytesRead;
            }
            if (digest.digest('hex') !== publication.files[name]?.sha256) throw fail();
          }
          const after = await handle.stat();
          const named = await fs.lstat(file);
          if (
            !sameStat(before, after) ||
            before.gid !== after.gid ||
            !sameStat(before, named) ||
            before.gid !== named.gid ||
            (await fs.realpath(file)) !== file
          )
            throw fail();
          verifiedFiles.add(signature);
          return before;
        } finally {
          await handle.close();
        }
      };
      const exists = async (file: string) => {
        try {
          await fs.lstat(file);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
          throw error;
        }
      };
      signal.throwIfAborted();
      const sourceNames = (await fs.readdir(sourceDirectory)).sort();
      const destinationNames = (await fs.readdir(destination)).sort();
      if (
        sourceNames.some((name) => !fileNames.includes(name)) ||
        destinationNames.some((name) => !fileNames.includes(name)) ||
        !sourceNames.includes('point.json') ||
        !destinationNames.includes('point.json')
      )
        throw fail();
      const pointFile = path.join(sourceDirectory, 'point.json');
      await inspect(pointFile, 'point.json');
      const pointBytes = await this.read(pointFile, 32768);
      if (hash(pointBytes) !== publication.files['point.json']?.sha256) throw fail();
      const sealed: unknown = JSON.parse(pointBytes.toString());
      if (!coreStoredPointSchema.allows(sealed) || sealed.status !== 'sealed' || !sealed.core) throw fail();
      const sealedCore = sealed.core;
      const reservation = (value: StoredCoreTimeMachinePoint) => ({
        version: value.version,
        id: value.id,
        ownerId: value.ownerId,
        createdAt: value.createdAt,
        envelope: value.envelope,
      });
      const core = publication.core;
      if (
        json(reservation(point)) !== json(reservation(sealed)) ||
        core.schema !== 'orbis.core-capture-publication.v1' ||
        core.pointId !== point.id ||
        core.ownerId !== point.ownerId ||
        core.createdAt !== point.createdAt ||
        core.pointReservationSha256 !== hash(json(reservation(point))) ||
        core.pointSha256 !== hash(pointBytes) ||
        core.metadataSha256 !== sealed.metadataSha256 ||
        core.metadataSha256 !== publication.files['metadata.orbis']?.sha256 ||
        core.cipherSha256 !== sealed.archiveSha256 ||
        core.cipherSha256 !== publication.files['core.orbis']?.sha256 ||
        core.cipherBytes !== sealed.archiveBytes ||
        core.cipherBytes !== publication.files['core.orbis']?.bytes ||
        !/^[a-f0-9]{64}$/.test(core.checkpoint.sha256) ||
        !Number.isSafeInteger(core.checkpoint.bytes) ||
        core.checkpoint.bytes < 1 ||
        ['manifestSha256', 'imageInventorySha256', 'captureReceiptSha256', 'sourceSha256', 'checkpointSha256', 'resourceCount', 'imageCount'].some(
          (key) => Reflect.get(core, key) !== Reflect.get(sealedCore, key),
        )
      )
        throw fail();
      const keyFile = path.join(root, 'keys/master-v1.key');
      const keyStat = await fs.lstat(keyFile);
      if (
        !keyStat.isFile() ||
        keyStat.nlink !== 1 ||
        keyStat.uid !== process.getuid?.() ||
        ![0o400, 0o600].includes(keyStat.mode & 0o7777) ||
        keyStat.size !== 32 ||
        (await fs.realpath(keyFile)) !== keyFile
      )
        throw fail();
      const key = await this.masterKey(false);
      try {
        if (hash(key) !== publication.keyId || publication.keyId !== point.envelope.keyId) throw fail();
      } finally {
        key.fill(0);
      }
      if (!sameStat(keyStat, await fs.lstat(keyFile))) throw fail();
      const localPointStat = await fs.lstat(path.join(destination, 'point.json'));
      if (
        !localPointStat.isFile() ||
        localPointStat.nlink !== 1 ||
        localPointStat.uid !== process.getuid?.() ||
        ![0o400, 0o600].includes(localPointStat.mode & 0o7777)
      )
        throw fail();
      const current = await this.load(point.id);
      if (
        current.version !== 3 ||
        (current.status === 'sealed'
          ? json(current) !== json(sealed) || !pointBytes.equals(await this.read(path.join(destination, 'point.json'), 32768))
          : json(current) !== json(point))
      )
        throw fail();
      const draft = await this.readCoreDraft(current, signal);
      // Retained draft and preview assets are independently captured and must match the published bytes.
      for (const name of fileNames.filter((name) => !['point.json', 'core.orbis', 'metadata.orbis'].includes(name))) {
        await inspect(path.join(sourceDirectory, name), name);
        await inspect(path.join(destination, name), name);
      }
      const expectedAssets = draft.preview.available
        ? [...(draft.preview.wallpaperAsset.available ? ['wallpaper.orbis'] : []), ...(draft.preview.appIcons ? ['icons.orbis'] : [])]
        : [];
      if (json(fileNames.filter((name) => ['wallpaper.orbis', 'icons.orbis'].includes(name)).sort()) !== json(expectedAssets.sort())) throw fail();
      const samePromotion = (a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>) =>
        ['dev', 'ino', 'mode', 'uid', 'gid', 'size', 'mtimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
      const promotionIdentities = new Map<string, Awaited<ReturnType<typeof fs.lstat>>>();
      for (const name of ['metadata.orbis', 'core.orbis']) {
        const src = path.join(sourceDirectory, name);
        const dst = path.join(destination, name);
        const hasSource = await exists(src);
        const hasDestination = await exists(dst);
        if (!hasSource && !hasDestination) throw fail();
        if (hasSource && hasDestination) {
          const a = await inspect(src, name, 2);
          const b = await inspect(dst, name, 2);
          if (a.dev !== b.dev || a.ino !== b.ino) throw fail();
          promotionIdentities.set(name, a);
        } else promotionIdentities.set(name, await inspect(hasSource ? src : dst, name));
      }
      // Finish an already verified interrupted metadata link so metadataRecord can open a single-link file.
      const metadataSource = path.join(sourceDirectory, 'metadata.orbis');
      const metadataDestination = path.join(destination, 'metadata.orbis');
      if ((await exists(metadataSource)) && (await exists(metadataDestination))) {
        const source = await inspect(metadataSource, 'metadata.orbis', 2);
        const target = await inspect(metadataDestination, 'metadata.orbis', 2);
        const original = promotionIdentities.get('metadata.orbis');
        if (!original || source.dev !== target.dev || source.ino !== target.ino || !samePromotion(source, original)) throw fail();
        await checkDirectories();
        await fs.unlink(metadataSource);
        await inspect(metadataDestination, 'metadata.orbis');
        await this.sync(destination);
        await this.sync(sourceDirectory);
      }
      const metadataDirectory = (await exists(metadataSource)) ? sourceDirectory : destination;
      const { metadata } = await this.metadataRecord(sealed, metadataDirectory);
      if (metadata.version !== 3) throw fail();
      const { archiveBytes: _bytes, archiveSha256: _sha, manifestSha256: _manifest, core: _core, ...metadataDraft } = metadata;
      if (json(metadataDraft) !== json(draft)) throw fail();
      await checkDirectories();
      for (const name of ['metadata.orbis', 'core.orbis']) {
        const src = path.join(sourceDirectory, name);
        const dst = path.join(destination, name);
        if (await exists(src)) {
          if (!(await exists(dst))) {
            await inspect(src, name);
            await fs.link(src, dst);
          }
          const a = await inspect(src, name, 2);
          const b = await inspect(dst, name, 2);
          const original = promotionIdentities.get(name);
          if (!original || a.dev !== b.dev || a.ino !== b.ino || !samePromotion(a, original)) throw fail();
          await checkDirectories();
          await fs.unlink(src);
        }
        const result = await inspect(dst, name);
        const original = promotionIdentities.get(name);
        if (!original || !samePromotion(result, original)) throw fail();
      }
      await this.sync(destination);
      await this.sync(sourceDirectory);
      await checkDirectories();
      if (
        json(await this.load(point.id)) !== json(current) ||
        !sameStat(localPointStat, await fs.lstat(path.join(destination, 'point.json'))) ||
        json((await fs.readdir(destination)).sort()) !== json(fileNames) ||
        json((await fs.readdir(sourceDirectory)).sort()) !== json(fileNames.filter((name) => !['metadata.orbis', 'core.orbis'].includes(name)))
      )
        throw fail();
      for (const name of fileNames.filter((name) => name !== 'point.json')) await inspect(path.join(destination, name), name);
      if (current.status !== 'sealed') await this.atomic(path.join(destination, 'point.json'), pointBytes, true);
      if (
        !pointBytes.equals(await this.read(path.join(destination, 'point.json'), 32768)) ||
        json(await this.load(point.id)) !== json(sealed) ||
        json((await fs.readdir(destination)).sort()) !== json(fileNames)
      )
        throw fail();
      for (const name of fileNames) await inspect(path.join(destination, name), name);
      await checkDirectories();
      signal.throwIfAborted();
    });
  }

  sealCore(point: StoredTimeMachinePoint, payload: VerifiedCorePayload, draft: TimeMachineCoreDraftMetadata, signal: AbortSignal) {
    return this.serialize(async () => {
      if (
        point.version !== 3 ||
        point.status !== 'capturing' ||
        point.backupJobId !== null ||
        point.core !== null ||
        draft.version !== 3 ||
        draft.id !== point.id ||
        draft.createdAt !== point.createdAt
      )
        throw timeMachineConflict('point-integrity-failed');
      const current = await this.load(point.id);
      if (JSON.stringify(current) !== JSON.stringify(point)) throw timeMachineConflict('point-integrity-failed');
      const directory = this.pointDirectory(point.id);
      const temporary = path.join(directory, `.core-${randomUUID()}.partial`);
      const linked: string[] = [];
      const assetBytes = draft.preview.available
        ? (draft.preview.wallpaperAsset.available ? draft.preview.wallpaperAsset.bytes + 52 : 0) +
          (draft.preview.appIcons ? draft.preview.appIcons.bytes + 52 : 0)
        : 0;
      try {
        const metadata = await withCorePayload(payload, signal, async ({ source, bytes, manifest, manifestSha256 }) => {
          if (manifest.pointId !== point.id || canonicalPublicationJson(manifest.compatibility) !== canonicalPublicationJson(draft.compatibility))
            throw timeMachineConflict('point-integrity-failed');
          const retained = (await this.list()).reduce(
            (sum, item) => sum + item.archiveBytes + (item.assetBytes ?? 0) + (item.version === 2 ? item.runtimeBytes : 0),
            0,
          );
          const space = await fs.statfs(directory);
          if (
            retained + bytes + backupCipherOverhead + assetBytes > timeMachineLimits.bytes ||
            space.bavail * space.bsize < bytes + backupCipherOverhead + 256 * 1024 * 1024
          )
            throw timeMachineConflict('capacity-exceeded');
          const encrypted = await encryptBackupStream({
            source,
            plaintextBytes: bytes,
            destination: temporary,
            passphrase: await this.unwrap(point),
            signal,
          });
          return timeMachineCoreMetadataSchema.assert({
            ...draft,
            archiveBytes: encrypted.bytes,
            archiveSha256: encrypted.sha256,
            manifestSha256,
            core: {
              version: 1,
              format: 'orbis.time-machine-core.v1',
              cipherBytes: encrypted.bytes,
              cipherSha256: encrypted.sha256,
              manifestSha256,
              sourceSha256: manifest.sourceSha256,
              checkpointSha256: manifest.checkpointSha256,
              captureReceiptSha256: manifest.captureReceiptSha256,
              imageInventorySha256: manifest.imageInventorySha256,
              imageCount: manifest.inventory.images.length,
              resourceCount: manifest.resourceCount,
            },
          });
        });
        const json = Buffer.from(JSON.stringify(metadata));
        if (json.length > timeMachineLimits.metadataBytes) throw timeMachineConflict('capacity-exceeded');
        const ciphertext = await backupMetadataBytes(json, await this.unwrap(point), false, timeMachineLimits.metadataBytes);
        signal.throwIfAborted();
        const metadataFile = path.join(directory, 'metadata.orbis');
        await this.atomic(metadataFile, ciphertext, false);
        linked.push(metadataFile);
        const coreFile = path.join(directory, 'core.orbis');
        await fs.link(temporary, coreFile);
        linked.push(coreFile);
        await fs.rm(temporary);
        await this.sync(directory);
        if (JSON.stringify(await this.load(point.id)) !== JSON.stringify(point)) throw timeMachineConflict('point-integrity-failed');
        await this.update({
          ...point,
          status: 'sealed',
          issue: null,
          archiveBytes: metadata.archiveBytes,
          archiveSha256: metadata.archiveSha256,
          metadataSha256: createHash('sha256').update(ciphertext).digest('hex'),
          assetBytes,
          core: metadata.core,
        });
        return metadata;
      } catch (error) {
        let latest: StoredTimeMachinePoint | undefined;
        try {
          latest = await this.load(point.id);
        } catch {
          /* An unreadable commit remains protected for reconciliation. */
        }
        if (latest && latest.status !== 'sealed') for (const file of linked) await fs.rm(file, { force: true });
        throw error;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    });
  }
  private async metadataRecord(point: StoredTimeMachinePoint, directory = this.pointDirectory(point.id)) {
    if (point.status !== 'sealed' || !point.metadataSha256) throw timeMachineConflict('point-not-found');
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
    if (point.version === 3 && parsed.version === 3 && canonicalPublicationJson(point.core) !== canonicalPublicationJson(parsed.core))
      throw timeMachineConflict('point-integrity-failed');
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
    const file = path.join(this.pointDirectory(point.id), point.version === 3 ? 'core.orbis' : 'backup.orbis');
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
      const after = await handle.stat();
      if (hash.digest('hex') !== point.archiveSha256 || !(point.version === 3 ? sameCoreDataStat(stat, after) : sameStat(stat, after)))
        throw timeMachineConflict('point-integrity-failed');
      if (point.version === 3 && !sameCoreDataStat(after, await fs.lstat(file))) throw timeMachineConflict('point-integrity-failed');
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
    if (point.version === 3) return this.withCoreArchive(point, signal, consume);
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
  private async withCoreArchive<T>(
    point: StoredCoreTimeMachinePoint,
    signal: AbortSignal,
    consume: (source: Readable, passphrase: string) => Promise<T>,
  ): Promise<T> {
    const proof = await this.verifyArchive(point, signal);
    const file = path.join(this.pointDirectory(point.id), 'core.orbis');
    await this.directory(path.dirname(file));
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let raw: ReturnType<FileHandle['createReadStream']> | undefined;
    let source: Transform | undefined;
    try {
      if (!sameCoreDataStat(proof, await handle.stat())) throw timeMachineConflict('point-integrity-failed');
      const passphrase = await this.unwrap(point);
      signal.throwIfAborted();
      const digest = createHash('sha256');
      let received = 0;
      source = new Transform({
        transform(chunk, _encoding, done) {
          const bytes = Buffer.from(chunk);
          digest.update(bytes);
          received += bytes.length;
          done(null, bytes);
        },
      });
      raw = handle.createReadStream({ autoClose: false, start: 0, end: point.archiveBytes - 1, signal });
      raw.on('error', (error) => source?.destroy(error));
      source.on('error', (error) => raw?.destroy(error));
      raw.pipe(source);
      const result = await consume(source, passphrase);
      const after = await handle.stat();
      // Ciphertext is data, not an operation grant: authenticate the delivered bytes.
      if (
        !source.readableEnded ||
        !raw.readableEnded ||
        received !== point.archiveBytes ||
        raw.bytesRead !== point.archiveBytes ||
        digest.digest('hex') !== point.archiveSha256 ||
        !sameCoreDataStat(proof, after) ||
        !sameCoreDataStat(after, await fs.lstat(file))
      )
        throw timeMachineConflict('point-integrity-failed');
      signal.throwIfAborted();
      return result;
    } finally {
      raw?.destroy();
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
    if (point.version === 3 && (await this.load(point.id)).status === 'sealed') throw timeMachineConflict('operation-busy');
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
      'core.orbis',
    ])
      await fs.rm(path.join(this.pointDirectory(point.id), name), { force: true });
  }
}

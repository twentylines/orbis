import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import {
  timeMachineIdSchema,
  timeMachineHashSchema,
  timeMachineComponentsMetadataSchema,
  timeMachineCaptureSelectionSchema,
  type TimeMachineComponentsMetadata,
  type TimeMachineCaptureSelection,
  timeMachineLimits,
  type TimeMachineCoreMetadata,
  type TimeMachinePoint,
} from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes, decryptBackup, encryptBackupStream } from './backup-crypto';
import { privateBackupDirectory } from './backup-files';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { HostSelectedCaptureClient } from '../host-updates/host-selected-capture-client';
import type { TimeMachineStore, StoredCoreTimeMachinePoint } from './time-machine-store';
import { timeMachineIssue } from './time-machine-policy';
import { verifySelectedComponent } from './time-machine-selected-component';

const fail = () => new Error('The selected capture needs recovery. Its saved components were preserved.');
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const envelopeSchema = type({
  nonce: 'string',
  tag: 'string',
  value: 'string',
  keyId: timeMachineHashSchema,
}).onUndeclaredKey('reject');
const pointSchema = type({
  version: '4',
  kind: "'components'",
  componentFormat: "'orbis.time-machine-components.v1'",
  id: timeMachineIdSchema,
  corePointId: timeMachineIdSchema,
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  status: "'capturing' | 'sealed' | 'interrupted' | 'failed'",
  planSha256: timeMachineHashSchema,
  selection: timeMachineCaptureSelectionSchema,
  archiveBytes: 'number.integer >= 0',
  archiveSha256: timeMachineHashSchema.or('null'),
  metadataSha256: timeMachineHashSchema.or('null'),
  envelope: envelopeSchema.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow(
    (point) =>
      point.status !== 'sealed' ||
      (point.envelope !== null && point.archiveSha256 !== null && point.metadataSha256 !== null && point.archiveBytes > 0),
  );
export type StoredComponentsPoint = typeof pointSchema.infer;
const same = (a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>) =>
  ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const names = ['core.orbis', 'capture-draft.orbis', 'metadata.orbis', 'apps.orbis', 'components-metadata.orbis', 'wallpaper.orbis', 'icons.orbis'];

export class TimeMachineComponentsStore {
  private seals = new Map<string, Promise<void>>();
  constructor(private readonly dataDir: string) {}
  private root() {
    return path.join(this.dataDir, 'backups/time-machine/components');
  }
  directory(id: string) {
    if (!timeMachineIdSchema.allows(id)) throw fail();
    return path.join(this.root(), id);
  }
  private async file(file: string, maximum = 2 ** 36 + 52) {
    if ((await fs.realpath(path.dirname(file))) !== path.dirname(file)) throw fail();
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.mode & 0o077 || parent.uid !== process.getuid?.()) throw fail();
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size > maximum) {
      await handle.close();
      throw fail();
    }
    return { handle, before };
  }
  private async read(file: string, maximum: number) {
    const { handle, before } = await this.file(file, maximum);
    try {
      const bytes = await handle.readFile();
      if (!same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw fail();
      return bytes;
    } finally {
      await handle.close();
    }
  }
  private async atomic(directory: string, name: string, value: Buffer | string, replace = false) {
    await privateBackupDirectory(directory);
    const temporary = path.join(directory, `.components-${randomUUID()}`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      if (replace) await fs.rename(temporary, path.join(directory, name));
      else {
        await fs.link(temporary, path.join(directory, name));
        await fs.unlink(temporary);
      }
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  async create(ownerId: number, id: string, corePointId: string, planSha256: string, selection: TimeMachineCaptureSelection) {
    const point = pointSchema.assert({
      version: 4,
      kind: 'components',
      componentFormat: 'orbis.time-machine-components.v1',
      id,
      corePointId,
      ownerId,
      createdAt: Date.now(),
      status: 'capturing',
      planSha256,
      selection,
      archiveBytes: 0,
      archiveSha256: null,
      metadataSha256: null,
      envelope: null,
    });
    await privateBackupDirectory(this.root());
    await this.atomic(this.directory(id), 'point.json', JSON.stringify(point));
    return point;
  }
  async load(id: string) {
    const point = pointSchema.assert(JSON.parse((await this.read(path.join(this.directory(id), 'point.json'), 65536)).toString()));
    if (point.id !== id) throw fail();
    return point;
  }
  async find(id: string) {
    try {
      return await this.load(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async list() {
    let entries: string[];
    try {
      entries = await fs.readdir(this.root());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (entries.length > 16 || entries.some((id) => !timeMachineIdSchema.allows(id))) throw fail();
    return Promise.all(entries.map((id) => this.load(id)));
  }
  private async master() {
    return this.read(path.join(this.dataDir, 'backups/time-machine/keys/master-v1.key'), 32);
  }
  private async wrap(point: StoredComponentsPoint, passphrase: string) {
    const key = await this.master();
    try {
      if (key.length !== 32) throw fail();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(`orbis-time-machine-components-key-v1:${point.id}:${point.ownerId}`));
      const value = Buffer.concat([cipher.update(passphrase), cipher.final()]);
      return { keyId: hash(key), nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), value: value.toString('hex') };
    } finally {
      key.fill(0);
    }
  }
  async key(point: StoredComponentsPoint) {
    const key = await this.master();
    try {
      const envelope = point.envelope;
      if (
        !envelope ||
        hash(key) !== envelope.keyId ||
        !/^[a-f0-9]{24}$/.test(envelope.nonce) ||
        !/^[a-f0-9]{32}$/.test(envelope.tag) ||
        !/^[a-f0-9]{86}$/.test(envelope.value)
      )
        throw fail();
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'hex'));
      cipher.setAAD(Buffer.from(`orbis-time-machine-components-key-v1:${point.id}:${point.ownerId}`));
      cipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
      return Buffer.concat([cipher.update(Buffer.from(envelope.value, 'hex')), cipher.final()]).toString();
    } finally {
      key.fill(0);
    }
  }
  private async copy(file: string, destination: string, expected?: string) {
    const { handle, before } = await this.file(file);
    const output = await fs.open(destination, 'wx', 0o600);
    const sha = createHash('sha256');
    try {
      for await (const raw of handle.createReadStream({ autoClose: false })) {
        sha.update(raw);
        let offset = 0;
        while (offset < raw.length) {
          const result = await output.write(raw, offset, raw.length - offset);
          if (!result.bytesWritten) throw fail();
          offset += result.bytesWritten;
        }
      }
      if (!same(before, await handle.stat()) || !same(before, await fs.lstat(file)) || (expected && sha.digest('hex') !== expected)) throw fail();
      await output.sync();
    } finally {
      await output.close();
      await handle.close();
    }
  }
  private async identity(file: string) {
    const fields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.mode & 0o077n || before.uid !== BigInt(process.getuid?.() ?? -1)) throw fail();
      const seal = (value: typeof before) => Object.fromEntries(fields.map((field) => [field, String(Reflect.get(value, field))]));
      const value = seal(before);
      if (
        canonicalPublicationJson(value) !== canonicalPublicationJson(seal(await handle.stat({ bigint: true }))) ||
        canonicalPublicationJson(value) !== canonicalPublicationJson(seal(await fs.lstat(file, { bigint: true })))
      )
        throw fail();
      return value;
    } finally {
      await handle.close();
    }
  }
  private async publicationSeal(point: StoredComponentsPoint, passphrase: string) {
    const directory = this.directory(point.id);
    const files: Record<string, Record<string, string>> = {};
    for (const name of await fs.readdir(directory)) {
      if (name === 'point.json') continue;
      if (!names.includes(name)) throw fail();
      files[name] = await this.identity(path.join(directory, name));
    }
    const seal = {
      schema: 'orbis.components-publication-seal.v1',
      pointId: point.id,
      corePointId: point.corePointId,
      pointSha256: hash(JSON.stringify(point)),
      metadataSha256: point.metadataSha256,
      files,
    };
    const encrypted = await backupMetadataBytes(Buffer.from(canonicalPublicationJson(seal)), passphrase, false, 65536);
    await this.atomic(directory, 'catalog-seal.orbis', encrypted);
  }
  seal(
    point: StoredComponentsPoint,
    core: StoredCoreTimeMachinePoint,
    metadata: TimeMachineCoreMetadata,
    store: TimeMachineStore,
    client: HostSelectedCaptureClient,
    signal: AbortSignal,
  ) {
    const existing = this.seals.get(point.id);
    if (existing) return existing;
    const work = this.sealOnce(point, core, metadata, store, client, signal).finally(() => this.seals.delete(point.id));
    this.seals.set(point.id, work);
    return work;
  }
  private async sealOnce(
    point: StoredComponentsPoint,
    core: StoredCoreTimeMachinePoint,
    metadata: TimeMachineCoreMetadata,
    store: TimeMachineStore,
    client: HostSelectedCaptureClient,
    signal: AbortSignal,
  ) {
    if (point.status === 'sealed' || core.status !== 'sealed' || core.id !== point.corePointId || core.ownerId !== point.ownerId) throw fail();
    const {
      archiveBytes: _archiveBytes,
      archiveSha256: _archiveSha256,
      manifestSha256: _manifestSha256,
      core: _coreSummary,
      ...expectedDraft
    } = metadata;
    if (canonicalPublicationJson(await store.readCoreDraft(core, signal)) !== canonicalPublicationJson(expectedDraft)) throw fail();
    const { receipt, receiptSha256 } = await client.receipt(core.id, signal);
    if (
      receipt.pointId !== point.id ||
      receipt.planSha256 !== point.planSha256 ||
      receipt.coreCheckpointSha256 !== metadata.core.checkpointSha256 ||
      canonicalPublicationJson(receipt.manifest.selection) !==
        canonicalPublicationJson(
          point.selection.apps.map((app) => ({ urn: app.urn, mountIds: [...app.mountIds].sort() })).sort((a, b) => a.urn.localeCompare(b.urn)),
        )
    )
      throw fail();
    const directory = this.directory(point.id);
    const required = BigInt(core.archiveBytes) + BigInt(receipt.artifact.bytes + 52) + BigInt(core.assetBytes ?? 0) + 2n * 1024n ** 2n;
    const existing =
      (await store.list()).reduce(
        (total, item) => total + BigInt(item.archiveBytes) + BigInt(item.assetBytes ?? 0) + BigInt(item.version === 2 ? item.runtimeBytes : 0),
        0n,
      ) + (await this.list()).reduce((total, item) => total + BigInt(item.archiveBytes), 0n);
    const temporaryBytes = BigInt(receipt.artifact.bytes) + 2n * BigInt(receipt.manifest.images.bytes);
    const space = await fs.statfs(directory, { bigint: true });
    if (required + existing > BigInt(timeMachineLimits.bytes) || space.bavail * space.bsize < required + temporaryBytes + 256n * 1024n ** 2n)
      throw fail();
    // A partial publication is evidence and must be recovered deliberately, never overwritten.
    if ((await fs.readdir(directory)).some((name) => name !== 'point.json')) throw fail();
    let components: TimeMachineComponentsMetadata | undefined;
    let envelope: Awaited<ReturnType<TimeMachineComponentsStore['wrap']>> | undefined;
    let publicationKey: string | undefined;
    await store.withArchive(core, signal, async (source, passphrase) => {
      const output = await fs.open(path.join(directory, 'core.orbis'), 'wx', 0o600);
      try {
        for await (const raw of source) {
          signal.throwIfAborted();
          let offset = 0;
          while (offset < raw.length) {
            const written = await output.write(raw, offset, raw.length - offset);
            if (!written.bytesWritten) throw fail();
            offset += written.bytesWritten;
          }
        }
        await output.sync();
      } finally {
        await output.close();
      }
      const base = path.join(this.dataDir, 'backups/time-machine/points', core.id);
      await this.copy(path.join(base, 'metadata.orbis'), path.join(directory, 'metadata.orbis'), core.metadataSha256 ?? undefined);
      const draftHash = hash(await this.read(path.join(base, 'capture-draft.orbis'), 512 * 1024 + 52));
      await this.copy(path.join(base, 'capture-draft.orbis'), path.join(directory, 'capture-draft.orbis'), draftHash);
      if (metadata.preview.available) {
        if (metadata.preview.wallpaperAsset.available)
          await this.copy(path.join(base, 'wallpaper.orbis'), path.join(directory, 'wallpaper.orbis'), metadata.preview.wallpaperAsset.cipherSha256);
        if (metadata.preview.appIcons)
          await this.copy(path.join(base, 'icons.orbis'), path.join(directory, 'icons.orbis'), metadata.preview.appIcons.cipherSha256);
      }
      const selected = await client.withArtifact(core.id, receiptSha256, receipt, signal, (source) =>
        encryptBackupStream({
          source,
          plaintextBytes: receipt.artifact.bytes,
          destination: path.join(directory, 'apps.orbis'),
          passphrase,
          signal,
        }),
      );
      const verification = await fs.mkdtemp(path.join(directory, 'verify-'));
      await fs.chmod(verification, 0o700);
      const plaintext = path.join(verification, 'apps.tar');
      const cleanup = async () => {
        const remaining = await fs.readdir(verification);
        if (remaining.some((name) => name !== 'apps.tar')) throw fail();
        if (remaining.includes('apps.tar')) {
          const stat = await fs.lstat(plaintext);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw fail();
          await fs.unlink(plaintext);
        }
        await fs.rmdir(verification);
      };
      try {
        await decryptBackup({ source: path.join(directory, 'apps.orbis'), destination: plaintext, passphrase, signal });
        await verifySelectedComponent({ file: plaintext, receipt, staging: verification, signal });
      } finally {
        await cleanup();
      }
      const summary = { receiptSha256, receipt, cipherBytes: selected.bytes, cipherSha256: selected.sha256 };
      const manifestSha256 = hash(
        canonicalPublicationJson({ schema: 'orbis.time-machine-components.v1', pointId: point.id, core: metadata.core, selected: summary }),
      );
      const { core: _core, coreFormat: _format, restorePolicy: _policy, compatibility: _compatibility, ...baseMetadata } = metadata;
      components = timeMachineComponentsMetadataSchema.assert({
        ...baseMetadata,
        version: 4,
        kind: 'components',
        componentFormat: 'orbis.time-machine-components.v1',
        id: point.id,
        createdAt: point.createdAt,
        coreComponent: metadata,
        selectedComponent: summary,
        coverage: { ...metadata.coverage, appData: true },
        restore: { ready: false, blockers: [timeMachineIssue('activation-not-integrated')] },
        archiveBytes: core.archiveBytes + selected.bytes,
        archiveSha256: hash(canonicalPublicationJson({ core: core.archiveSha256, selected: selected.sha256 })),
        manifestSha256,
        excludedApps: (metadata.preview.available ? metadata.preview.apps : [])
          .filter((app) => !point.selection.apps.some((included) => included.urn === app.urn))
          .map((app) => app.urn),
      });
      envelope = await this.wrap(point, passphrase);
      publicationKey = passphrase;
      const ciphertext = await backupMetadataBytes(Buffer.from(JSON.stringify(components)), passphrase, false, 2 * 1024 ** 2);
      await this.atomic(directory, 'components-metadata.orbis', ciphertext);
    });
    if (!components || !envelope || !publicationKey || canonicalPublicationJson(await this.load(point.id)) !== canonicalPublicationJson(point))
      throw fail();
    const metadataBytes = await this.read(path.join(directory, 'components-metadata.orbis'), 2 * 1024 ** 2 + 52);
    const sealed = pointSchema.assert({
      ...point,
      status: 'sealed',
      envelope,
      archiveBytes: components.archiveBytes,
      archiveSha256: components.archiveSha256,
      metadataSha256: hash(metadataBytes),
    });
    await this.publicationSeal(sealed, publicationKey);
    await this.atomic(directory, 'point.json', JSON.stringify(sealed), true);
  }
  async metadata(point: StoredComponentsPoint) {
    if (point.status !== 'sealed' || !point.metadataSha256) throw fail();
    const bytes = await this.read(path.join(this.directory(point.id), 'components-metadata.orbis'), 2 * 1024 ** 2 + 52);
    if (hash(bytes) !== point.metadataSha256) throw fail();
    const plain = await backupMetadataBytes(bytes, await this.key(point), true, 2 * 1024 ** 2);
    try {
      const metadata = timeMachineComponentsMetadataSchema.assert(JSON.parse(plain.toString()));
      if (
        metadata.id !== point.id ||
        metadata.archiveSha256 !== point.archiveSha256 ||
        metadata.archiveBytes !== point.archiveBytes ||
        metadata.selectedComponent.receipt.planSha256 !== point.planSha256 ||
        metadata.selectedComponent.receiptSha256 !== hash(canonicalPublicationJson(metadata.selectedComponent.receipt)) ||
        metadata.archiveSha256 !==
          hash(canonicalPublicationJson({ core: metadata.coreComponent.archiveSha256, selected: metadata.selectedComponent.cipherSha256 })) ||
        metadata.manifestSha256 !==
          hash(
            canonicalPublicationJson({
              schema: 'orbis.time-machine-components.v1',
              pointId: point.id,
              core: metadata.coreComponent.core,
              selected: metadata.selectedComponent,
            }),
          )
      )
        throw fail();
      return metadata;
    } finally {
      plain.fill(0);
    }
  }
  async public(point: StoredComponentsPoint): Promise<TimeMachinePoint> {
    return {
      id: point.id,
      createdAt: point.createdAt,
      status: point.status,
      captureBinding: { version: 1, corePointId: point.corePointId, componentsPointId: point.id },
      stage: point.status === 'sealed' ? 'complete' : 'capturing-apps',
      completedBytes: 0,
      totalBytes: null,
      issue: point.status === 'interrupted' || point.status === 'failed' ? timeMachineIssue('capture-recovery-required') : null,
      backupJobId: null,
      metadata: point.status === 'sealed' ? await this.observe(point) : null,
    };
  }
  async interrupted(point: StoredComponentsPoint) {
    if (point.status === 'sealed') throw fail();
    await this.atomic(this.directory(point.id), 'point.json', JSON.stringify(pointSchema.assert({ ...point, status: 'interrupted' })), true);
  }
  async remove(point: StoredComponentsPoint) {
    if (point.status !== 'sealed') throw fail();
    await this.metadata(point);
    const directory = this.directory(point.id);
    const entries = await fs.readdir(directory);
    if (entries.some((name) => !['point.json', 'catalog-seal.orbis'].includes(name) && !names.includes(name))) throw fail();
    for (const name of entries) {
      const { handle } = await this.file(path.join(directory, name));
      await handle.close();
    }
    for (const name of entries) await fs.unlink(path.join(directory, name));
    await fs.rmdir(directory);
    return { removed: true };
  }
  async entries(point: StoredComponentsPoint, signal: AbortSignal) {
    const metadata = await this.observe(point);
    const entries = [];
    for (const name of await fs.readdir(this.directory(point.id))) {
      if (name === 'point.json' || name === 'catalog-seal.orbis') continue;
      if (!names.includes(name)) throw fail();
      const file = path.join(this.directory(point.id), name);
      const { handle, before } = await this.file(file);
      const digest = createHash('sha256');
      try {
        for await (const bytes of handle.createReadStream({ autoClose: false, signal })) digest.update(bytes);
        if (!same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw fail();
      } finally {
        await handle.close();
      }
      entries.push({ name, file, bytes: before.size, sha256: digest.digest('hex') });
    }
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    if (
      byName.get('core.orbis')?.sha256 !== metadata.coreComponent.archiveSha256 ||
      byName.get('apps.orbis')?.sha256 !== metadata.selectedComponent.cipherSha256 ||
      byName.get('components-metadata.orbis')?.sha256 !== point.metadataSha256
    )
      throw fail();
    return { metadata, pointKey: await this.key(point), entries };
  }
  async observe(point: StoredComponentsPoint) {
    const metadata = await this.metadata(point);
    const directory = this.directory(point.id);
    const bytes = await this.read(path.join(directory, 'catalog-seal.orbis'), 65536 + 52);
    const plain = await backupMetadataBytes(bytes, await this.key(point), true, 65536);
    try {
      const seal = JSON.parse(plain.toString()) as {
        schema: string;
        pointId: string;
        corePointId: string;
        pointSha256: string;
        metadataSha256: string;
        files: Record<string, Record<string, string>>;
      };
      if (
        !seal ||
        Object.keys(seal).sort().join(',') !== 'corePointId,files,metadataSha256,pointId,pointSha256,schema' ||
        seal.schema !== 'orbis.components-publication-seal.v1' ||
        seal.pointId !== point.id ||
        seal.corePointId !== point.corePointId ||
        seal.pointSha256 !== hash(await this.read(path.join(directory, 'point.json'), 65536)) ||
        seal.metadataSha256 !== point.metadataSha256 ||
        !seal.files ||
        typeof seal.files !== 'object' ||
        Array.isArray(seal.files)
      )
        throw fail();
      const expected = [
        'core.orbis',
        'capture-draft.orbis',
        'metadata.orbis',
        'apps.orbis',
        'components-metadata.orbis',
        ...(metadata.preview.available && metadata.preview.wallpaperAsset.available ? ['wallpaper.orbis'] : []),
        ...(metadata.preview.available && metadata.preview.appIcons ? ['icons.orbis'] : []),
      ].sort();
      if (
        Object.keys(seal.files).sort().join(',') !== expected.join(',') ||
        (await fs.readdir(directory)).sort().join(',') !== [...expected, 'point.json', 'catalog-seal.orbis'].sort().join(',')
      )
        throw fail();
      for (const name of expected)
        if (canonicalPublicationJson(await this.identity(path.join(directory, name))) !== canonicalPublicationJson(seal.files[name])) throw fail();
      return metadata;
    } finally {
      plain.fill(0);
    }
  }
}

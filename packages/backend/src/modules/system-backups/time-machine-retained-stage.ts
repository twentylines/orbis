import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeControllerConfigurationCapture } from '../host-updates/host-controller-config';
import { hashCaptureSnapshotFile } from './time-machine-capture-coherence';
import { appRuntimeEntryLimit, appRuntimeEntryName } from './time-machine-app-runtime-capture';
import { verifyCaptureAgainstBackup } from './backup-image-capture';
import { canonicalRuntimeJson, decodeRuntimePayloadManifest } from './time-machine-runtime-payload';
import type { TimeMachineStore } from './time-machine-store';
import type { ClaimedBackupSource } from './backup-imports.service';
import type { BackupRestoreJournal } from './backup-restore-journal';

const fail = () => new Error('Retained restore staging requires recovery.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
type Admitted = Awaited<ReturnType<TimeMachineStore['requireCoherentRuntime']>>;

async function copyEntry(source: string, destination: string, expected: { bytes: number; sha256: string }, signal: AbortSignal) {
  const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: fs.FileHandle | undefined;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size !== expected.bytes ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    output = await fs.open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    let written = 0;
    for await (const chunk of input.createReadStream({ autoClose: false, signal })) {
      const bytes = Buffer.from(chunk);
      hash.update(bytes);
      written += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const result = await output.write(bytes, offset);
        if (!result.bytesWritten) throw fail();
        offset += result.bytesWritten;
      }
    }
    const after = await input.stat();
    const current = await fs.lstat(source);
    if (
      written !== expected.bytes ||
      hash.digest('hex') !== expected.sha256 ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}

/** Called inside the claimed-source callback, after point-bound admission and before protected root review. */
export async function stageRetainedRuntime(options: {
  journal: BackupRestoreJournal;
  source: ClaimedBackupSource;
  admitted: Admitted;
  expectedManifestSha256: string;
  signal: AbortSignal;
}) {
  const { journal, source, admitted, signal } = options;
  const state = await journal.refresh();
  if (state.phase !== 'staging' || state.decision !== null || !/^[a-f0-9]{64}$/.test(options.expectedManifestSha256)) throw fail();
  const manifest = decodeRuntimePayloadManifest(admitted.manifest);
  if (
    !['orbis.time-machine-runtime.v3', 'orbis.time-machine-runtime.v4', 'orbis.time-machine-runtime.v6'].includes(manifest.schema) ||
    !admitted.coherence ||
    !admitted.controllerAuthority
  )
    throw fail();
  const manifestBytes = Buffer.from(canonicalRuntimeJson(manifest));
  if (
    sha(manifestBytes) !== options.expectedManifestSha256 ||
    manifest.pointId !== admitted.coherence.pointId ||
    manifest.legacy.manifestSha256 !== source.seal.manifest.sha256
  )
    throw fail();
  const dump = await hashCaptureSnapshotFile(path.join(source.directory, 'content', 'database.dump'), signal);
  if (dump.bytes !== admitted.coherence.database.bytes || dump.sha256 !== admitted.coherence.database.sha256) throw fail();
  await verifyCaptureAgainstBackup({
    capture: admitted.capture,
    content: path.join(source.directory, 'content'),
    manifestSha256: manifest.legacy.manifestSha256,
    signal,
    ...(manifest.schema === 'orbis.time-machine-runtime.v6' && admitted.appRuntime ? { appRuntime: admitted.appRuntime } : {}),
  });
  const entries = new Map(manifest.entries.map((entry) => [entry.name, entry]));
  const bytesFor = async (name: string) => {
    const entry = entries.get(name);
    const file = admitted.files.get(name);
    if (
      !entry ||
      !file ||
      entry.bytes > (manifest.schema === 'orbis.time-machine-runtime.v6' && name === appRuntimeEntryName ? appRuntimeEntryLimit : 4 * 1024 * 1024)
    )
      throw fail();
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size !== entry.bytes || (process.getuid && stat.uid !== process.getuid()))
        throw fail();
      const bytes = await handle.readFile();
      if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw fail();
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const configuration = decodeControllerConfigurationCapture(
    {
      ...manifest.configuration,
      files: await Promise.all(
        manifest.configuration.files.map(async (file) =>
          file.present ? { ...file, data: (await bytesFor(`controller-config/${file.path}`)).toString('base64') } : file,
        ),
      ),
    },
    { pointId: manifest.pointId, controllerId: manifest.controller.containerId, imageId: manifest.controller.sourceImageId },
  );
  const retained = path.join(journal.directory, 'retained');
  await fs.mkdir(retained, { mode: 0o700 });
  try {
    const write = async (name: string, bytes: Uint8Array) => {
      signal.throwIfAborted();
      const file = await fs.open(path.join(retained, name), 'wx', 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    };
    await write('runtime-manifest.json', manifestBytes);
    await write(
      'controller-config.json',
      Buffer.from(
        canonicalRuntimeJson({
          ...manifest.configuration,
          files: manifest.configuration.files.map((file) =>
            file.present ? { ...file, data: configuration.read(file.path)?.toString('base64') } : file,
          ),
        }),
      ),
    );
    for (const [destination, sourceName] of [
      ['image-capture.json', 'image-capture/capture.json'],
      ['controller-publication.json', 'controller-publication/proof.json'],
      ['controller-authority.json', 'controller-authority/receipt.json'],
      ['coherence.json', 'coherence/receipt.json'],
    ] as const)
      await write(destination, await bytesFor(sourceName));
    if (manifest.schema === 'orbis.time-machine-runtime.v4' || manifest.schema === 'orbis.time-machine-runtime.v6')
      await write('proxy-host-identity.json', await bytesFor('host-identity/proxy.json'));
    if (manifest.schema === 'orbis.time-machine-runtime.v6') {
      if (!admitted.appRuntime || admitted.controllerAuthority.metadata.version !== 4) throw fail();
      const appRuntime = await bytesFor(appRuntimeEntryName);
      if (
        !appRuntime.equals(admitted.appRuntime.read()) ||
        sha(appRuntime) !== manifest.appRuntimeSha256 ||
        sha(appRuntime) !== admitted.controllerAuthority.metadata.appRuntimeSha256
      )
        throw fail();
      await write('app-runtime.json', appRuntime);
    }
    const imageDirectory = path.join(retained, 'images');
    await fs.mkdir(imageDirectory, { mode: 0o700 });
    const images = manifest.entries.filter((entry) => /^image-capture\/images\/image-[a-f0-9]{64}\.tar$/.test(entry.name));
    for (const entry of images) {
      const sourceFile = admitted.files.get(entry.name);
      if (!sourceFile) throw fail();
      await copyEntry(sourceFile, path.join(imageDirectory, path.basename(entry.name)), entry, signal);
    }
    const controllerName = `image-capture/images/image-${manifest.controller.sourceImageId.slice('sha256:'.length)}.tar`;
    const controllerEntry = entries.get(controllerName);
    const controllerFile = admitted.files.get(controllerName);
    if (!controllerEntry || !controllerFile) throw fail();
    await copyEntry(controllerFile, path.join(retained, 'controller-image.tar'), controllerEntry, signal);
    for (const directory of [imageDirectory, retained, journal.directory]) {
      const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { manifestSha256: options.expectedManifestSha256 };
  } catch (error) {
    await fs.rm(retained, { recursive: true, force: true });
    throw error;
  }
}

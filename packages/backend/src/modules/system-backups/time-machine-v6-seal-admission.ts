import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requireProtectedV6CaptureAuthority } from '../host-updates/host-updates.service';
import { isBackupImportsServiceInstance, type BackupImportsService } from './backup-imports.service';
import { verifyCaptureAgainstBackup } from './backup-image-capture';
import { hashCaptureSnapshotFile } from './time-machine-capture-coherence';
import { canonicalRuntimeJson, runtimePayload, type CapturedRuntimeInput } from './time-machine-runtime-payload';
import { timeMachineConflict } from './time-machine-policy';

export type V6SealAdmission = object;
type Binding = {
  input: CapturedRuntimeInput;
  pointId: string;
  ownerId: number;
  bytes: number;
  manifestSha256: string;
  fingerprint: string;
  imports: BackupImportsService;
  passphrase: string;
  used: boolean;
};
const bindings = new WeakMap<V6SealAdmission, Binding>();
const fail = () => timeMachineConflict('point-integrity-failed');
const fingerprint = (manifest: { legacy: { cipherSha256: string } }) =>
  createHash('sha256')
    .update(canonicalRuntimeJson({ ...manifest, legacy: { ...manifest.legacy, cipherSha256: '0'.repeat(64) } }))
    .digest('hex');

export function createV6SealAdmission(options: {
  input: CapturedRuntimeInput;
  pointId: string;
  ownerId: number;
  bytes: number;
  manifestSha256: string;
  passphrase: string;
  imports: BackupImportsService;
  signal: AbortSignal;
}): V6SealAdmission {
  const { input, pointId, ownerId, bytes, manifestSha256, passphrase, imports, signal } = options;
  if (
    !isBackupImportsServiceInstance(imports) ||
    !input.appRuntime ||
    !input.controllerAuthority ||
    !input.coherence ||
    input.images.capture.schema !== 'orbis.time-machine-image-capture.v2' ||
    !Number.isSafeInteger(ownerId) ||
    ownerId < 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 52 ||
    !/^[a-f0-9]{64}$/.test(manifestSha256) ||
    passphrase.length < 12 ||
    passphrase.length > 1024
  )
    throw fail();
  requireProtectedV6CaptureAuthority(input.controllerAuthority, input.appRuntime, pointId);
  const payload = runtimePayload(input, { bytes, cipherSha256: '0'.repeat(64), manifestSha256 }, signal);
  payload.stream.destroy();
  if (payload.manifest.schema !== 'orbis.time-machine-runtime.v6' || payload.manifest.pointId !== pointId) throw fail();
  const admission = Object.freeze({});
  bindings.set(admission, {
    input,
    pointId,
    ownerId,
    bytes,
    manifestSha256,
    fingerprint: fingerprint(payload.manifest),
    imports,
    passphrase,
    used: false,
  });
  return admission;
}

export function requireV6SealAdmission(
  admission: V6SealAdmission | undefined,
  input: CapturedRuntimeInput,
  point: { id: string; ownerId: number },
  manifest: { schema: string; legacy: { bytes: number; cipherSha256: string; manifestSha256: string } },
) {
  const binding = admission && bindings.get(admission);
  if (
    !binding ||
    binding.used ||
    binding.input !== input ||
    binding.pointId !== point.id ||
    binding.ownerId !== point.ownerId ||
    manifest.schema !== 'orbis.time-machine-runtime.v6' ||
    manifest.legacy.bytes !== binding.bytes ||
    manifest.legacy.manifestSha256 !== binding.manifestSha256 ||
    fingerprint(manifest) !== binding.fingerprint ||
    !input.appRuntime ||
    !input.controllerAuthority
  )
    throw fail();
  requireProtectedV6CaptureAuthority(input.controllerAuthority, input.appRuntime, point.id);
}

export async function reviewV6SealArchive(
  admission: V6SealAdmission,
  input: CapturedRuntimeInput,
  point: { id: string; ownerId: number },
  file: string,
  verifiedCapture: Record<string, unknown>,
  archiveSha256: string,
  signal: AbortSignal,
) {
  const binding = bindings.get(admission);
  if (
    !binding ||
    binding.used ||
    binding.input !== input ||
    binding.pointId !== point.id ||
    binding.ownerId !== point.ownerId ||
    !input.appRuntime ||
    !input.coherence ||
    !/^[a-f0-9]{64}$/.test(archiveSha256)
  )
    throw fail();
  binding.used = true;
  let importId: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const inputHandle = handle;
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size !== binding.bytes ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    await binding.imports.reviewRetained(
      point.ownerId,
      { pointId: point.id, bytes: binding.bytes, archiveSha256, manifestSha256: binding.manifestSha256 },
      async (ownSignal, consume) => {
        ownSignal.throwIfAborted();
        await consume(inputHandle.createReadStream({ autoClose: false, signal: ownSignal }), binding.passphrase);
      },
      signal,
      (id) => {
        importId = id;
      },
      async (content, ownSignal) => {
        await verifyCaptureAgainstBackup({
          capture: verifiedCapture,
          content,
          manifestSha256: binding.manifestSha256,
          appRuntime: input.appRuntime,
          signal: ownSignal,
        });
        const dump = await hashCaptureSnapshotFile(path.join(content, 'database.dump'), ownSignal);
        if (dump.bytes !== input.coherence?.database.bytes || dump.sha256 !== input.coherence.database.sha256) throw fail();
      },
      input.appRuntime,
    );
    const after = await handle.stat();
    const current = await fs.lstat(file);
    if (
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
  } finally {
    binding.passphrase = '';
    await handle?.close();
    if (importId) await binding.imports.remove(importId, point.ownerId);
  }
}

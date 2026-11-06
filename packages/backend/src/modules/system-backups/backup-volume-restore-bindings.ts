import { createHash } from 'node:crypto';
import { type AppVolumePins, encodeAppVolumePins } from '../docker/app-volume-pins';
import { canonicalPublicationJson as canonical } from '../host-updates/host-controller-publication';
import type { VolumeRestoreIdentity, VolumeRestoreTarget } from './backup-docker-volume-restore';
import { BackupRequirementError } from './backup-files';
import { type BackupSourceSeal, validateBackupSource } from './backup-restore-source';
import { withPreparedVolumeRestoreRecord } from './backup-volume-restore-record';

const sha = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fail = () => new BackupRequirementError('Restored app storage could not be connected. Your original app storage has been preserved.');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export type PreparedVolumeRestoreBindings = Readonly<{
  restore: Readonly<VolumeRestoreIdentity & { preparedReceiptSha256: string }>;
  restoreSourceSha256: string;
  preparedGeneration: string;
  pinDocuments: readonly Readonly<{ appUrn: string; filename: string; sha256: string; json: string }>[];
  expectedTargets: readonly Readonly<VolumeRestoreTarget>[];
}>;

/** Retains the preparation lease through a code-owned root review/selection callback.
 * Source authorization, its outer restore lease and the runtime fence remain the caller's responsibility.
 */
export async function withPreparedVolumeRestoreBindings<T>(
  options: {
    sourceDirectory: string;
    sourceSeal: BackupSourceSeal;
    preparedDirectory: string;
    identity: VolumeRestoreIdentity;
    signal: AbortSignal;
  },
  consume: (plan: PreparedVolumeRestoreBindings) => Promise<T>,
): Promise<T> {
  const sourceSeal = structuredClone(options.sourceSeal);
  const identity = structuredClone(options.identity);
  if (identity.manifestSha256 !== sourceSeal.manifest.sha256) throw fail();
  const source = await validateBackupSource({ directory: options.sourceDirectory, expected: sourceSeal, signal: options.signal });
  const receiptOptions = { directory: options.preparedDirectory, identity, parsedFullBackupManifest: source.manifest };
  return withPreparedVolumeRestoreRecord(receiptOptions, async (prepared) => {
    const targetByKey = new Map(prepared.targets.map((target) => [target.key, target]));
    const apps = new Map(source.volumeApps.map((app) => [app.project, app]));
    const bindings = new Map<string, AppVolumePins>();
    for (const volume of source.manifest.volumes ?? []) {
      options.signal.throwIfAborted();
      const target = targetByKey.get(volume.key);
      if (!target) throw fail();
      for (const mount of volume.mounts) {
        const app = apps.get(mount.project);
        if (!app) throw fail();
        let pins = bindings.get(app.appUrn);
        if (!pins) {
          pins = { version: 1, appUrn: app.appUrn, project: app.project, services: [] };
          bindings.set(app.appUrn, pins);
        }
        let service = pins.services.find((item) => item.name === mount.service);
        if (!service) {
          service = { name: mount.service, mounts: [] };
          pins.services.push(service);
        }
        const previous = service.mounts.find((item) => item.target === mount.target);
        if (previous) {
          if (previous.volume !== target.targetName || previous.readOnly !== mount.readOnly) throw fail();
        } else service.mounts.push({ target: mount.target, volume: target.targetName, readOnly: mount.readOnly });
      }
    }
    if (!bindings.size) throw fail();
    const pinDocuments = [...bindings.values()]
      .sort((a, b) => compare(a.appUrn, b.appUrn))
      .map((pins) => {
        pins.services.sort((a, b) => compare(a.name, b.name));
        for (const service of pins.services) service.mounts.sort((a, b) => compare(a.target, b.target));
        const bytes = encodeAppVolumePins(pins);
        return Object.freeze({ appUrn: pins.appUrn, filename: `${sha(pins.appUrn)}.json`, sha256: sha(bytes), json: bytes.toString('utf8') });
      });
    options.signal.throwIfAborted();
    const restore = Object.freeze({ ...identity, preparedReceiptSha256: sha(canonical(prepared)) });
    return consume(
      Object.freeze({
        restore,
        restoreSourceSha256: sha(canonical(sourceSeal)),
        preparedGeneration: prepared.generation,
        pinDocuments: Object.freeze(pinDocuments),
        expectedTargets: prepared.targets,
      }),
    );
  });
}

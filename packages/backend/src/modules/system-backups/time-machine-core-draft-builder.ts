import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { historicalIconLimits } from '@runtipi/common/schemas/time-machine-icons';
import { timeMachineAssetLimit } from '@runtipi/common/schemas/time-machine';
import { themePackStateSchema } from '@runtipi/common/schemas/theme-pack';
import { backupMaintenanceActive, coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { copyBackupFiles, inventoryBackup } from './backup-files';
import { historicalHomePreview } from './time-machine-preview';
import { snapshotWallpaper } from './time-machine-assets';
import { snapshotAppIcons } from './time-machine-app-icons';
import { timeMachineIssue } from './time-machine-policy';
import type { LocalBackupSnapshot } from './system-backups.service';
import type { StoredCoreTimeMachinePoint, TimeMachineCoreDraftMetadata, TimeMachineStore } from './time-machine-store';

type Options = {
  dataDirectory: string;
  store: TimeMachineStore;
  point: StoredCoreTimeMachinePoint;
  label: string;
  software: { orbis: string; runtipi: string; architecture: string };
  compatibility: TimeMachineCoreDraftMetadata['compatibility'];
  apps: readonly { urn: string; name: string; running: boolean }[];
  signal: AbortSignal;
};
const fail = () => new Error('Core capture preview could not be safely prepared.');
const metadataLimit = 128 * 1024;
const aggregateLimit = 2 * metadataLimit + 3 * timeMachineAssetLimit + historicalIconLimits.totalImageBytes;

export async function buildCoreCaptureDraft(options: Options): Promise<TimeMachineCoreDraftMetadata> {
  const { dataDirectory, store, point, signal } = options;
  const held = async () => {
    signal.throwIfAborted();
    if (
      installationMode().phase !== 'normal' ||
      !backupMaintenanceActive() ||
      coreCaptureRecoveryRequired() ||
      point.status !== 'capturing' ||
      point.version !== 3
    )
      throw fail();
    if (canonicalPublicationJson(await store.load(point.id)) !== canonicalPublicationJson(point)) throw fail();
    signal.throwIfAborted();
  };
  await held();
  if (
    options.apps.length > historicalIconLimits.icons ||
    new Set(options.apps.map((app) => app.urn)).size !== options.apps.length ||
    options.apps.some((app) => app.urn.length > 180 || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(app.urn))
  )
    throw fail();
  const apps = structuredClone(options.apps);
  const root = path.resolve(dataDirectory);
  const pointDir = path.join(root, 'backups', 'time-machine', 'points', point.id);
  const pointStat = await fs.lstat(pointDir);
  if (
    !pointStat.isDirectory() ||
    pointStat.isSymbolicLink() ||
    pointStat.mode & 0o077 ||
    (process.getuid && pointStat.uid !== process.getuid()) ||
    (await fs.realpath(pointDir)) !== pointDir
  )
    throw fail();
  const work = await fs.mkdtemp(path.join(pointDir, 'preview-'));
  const workStat = await fs.lstat(work);
  const files: { name: string; bytes: number }[] = [];
  let total = 0;
  let iconsTotal = 0;
  const copy = async (entries: { relative: string; limit: number; icon?: boolean }[]) => {
    const roots: { name: string; source: string; required: true }[] = [];
    const limits = new Map<string, { limit: number; icon?: boolean }>();
    for (const entry of entries) {
      signal.throwIfAborted();
      let current = root;
      let absent = false;
      const parts = entry.relative.split('/');
      for (const [index, part] of parts.entries()) {
        current = path.join(current, part);
        let stat: Awaited<ReturnType<typeof fs.lstat>>;
        try {
          stat = await fs.lstat(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            absent = true;
            break;
          }
          throw error;
        }
        if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw fail();
        if (index === parts.length - 1 && stat.size > entry.limit) throw fail();
      }
      if (absent) continue;
      const name = `data/${entry.relative}`;
      roots.push({ name, source: current, required: true });
      limits.set(name, entry);
    }
    const inventory = await inventoryBackup(roots, signal);
    for (const file of inventory.files) {
      const limit = limits.get(file.name);
      if (!limit || file.bytes > limit.limit) throw fail();
      total += file.bytes;
      if (limit.icon) iconsTotal += file.bytes;
    }
    if (total > aggregateLimit || iconsTotal > historicalIconLimits.totalImageBytes) throw fail();
    const copied = await copyBackupFiles(inventory, work, signal, () => undefined);
    files.push(...copied);
    await held();
  };
  await copy([
    { relative: `state/desktop/${point.ownerId}.json`, limit: metadataLimit },
    { relative: `state/theme-packs/${point.ownerId}/registry.json`, limit: metadataLimit },
    { relative: `state/wallpapers/${point.ownerId}.image`, limit: timeMachineAssetLimit },
    { relative: `state/wallpapers/${point.ownerId}.image.saved`, limit: timeMachineAssetLimit },
    ...apps.flatMap(({ urn }) => {
      const [name, repo] = urn.split(':');
      return [
        { relative: `apps/${repo}/${name}/metadata/logo.jpg`, limit: historicalIconLimits.imageBytes, icon: true },
        { relative: `repos/${repo}/apps/${name}/metadata/logo.jpg`, limit: historicalIconLimits.imageBytes, icon: true },
      ];
    }),
  ]);
  const registryName = `data/state/theme-packs/${point.ownerId}/registry.json`;
  if (files.some((file) => file.name === registryName)) {
    let state: unknown;
    try {
      state = JSON.parse(await fs.readFile(path.join(work, registryName), 'utf8'));
    } catch {
      state = undefined;
    }
    const parsed = themePackStateSchema(state);
    if (!(parsed instanceof type.errors) && parsed.selected) {
      const selected = parsed.installed.find((item) => item.manifest.id === parsed.selected?.id && item.manifest.version === parsed.selected.version);
      if (selected && createHash('sha256').update(JSON.stringify(selected.manifest)).digest('hex') === selected.digest)
        await copy([
          {
            relative: `state/theme-packs/${point.ownerId}/${selected.manifest.id}/${selected.manifest.version}/${selected.manifest.wallpaper}`,
            limit: timeMachineAssetLimit,
          },
        ]);
    }
  }
  const snapshot: LocalBackupSnapshot = {
    content: work,
    createdAt: point.createdAt,
    manifestSha256: '',
    software: options.software,
    files,
    databaseBytes: 0,
    apps,
  };
  let preview = await historicalHomePreview(snapshot, point.ownerId);
  await held();
  const wallpaper = await snapshotWallpaper(snapshot, preview, point.ownerId);
  await held();
  const savedWallpaper = wallpaper ? await store.retainWallpaper(point, wallpaper, signal) : null;
  await held();
  const icons = preview.available ? await snapshotAppIcons(snapshot, signal) : null;
  await held();
  const savedIcons = icons ? await store.retainAppIcons(point, icons, signal) : null;
  await held();
  if (preview.available)
    preview = {
      ...preview,
      ...(savedWallpaper ? { wallpaperAsset: savedWallpaper, customWallpaperAvailable: savedWallpaper.source === 'captured-custom' } : {}),
      ...(savedIcons ? { appIcons: savedIcons } : {}),
    };
  const draft: TimeMachineCoreDraftMetadata = {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: options.label,
    source: 'manual',
    software: options.software,
    coverage: {
      database: true,
      configuration: true,
      appearance: true,
      controllerConfiguration: true,
      controllerVersion: true,
      dockerImages: true,
      appData: false,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [timeMachineIssue('activation-not-integrated')] },
    preview,
    breakdown: [],
    excludedApps: [],
    restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
    compatibility: options.compatibility,
  };
  await store.saveCoreDraft(point, draft, signal);
  await held();
  const after = await fs.lstat(work);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== workStat.dev ||
    after.ino !== workStat.ino ||
    (await fs.realpath(work)) !== work
  )
    throw fail();
  await fs.rm(work, { recursive: true });
  signal.throwIfAborted();
  return draft;
}

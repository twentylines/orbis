import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { normaliseDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { themePackStateSchema } from '@runtipi/common/schemas/theme-pack';
import { timeMachinePreviewSchema, type TimeMachinePreview } from '@runtipi/common/schemas/time-machine';
import { desktopPreferencesSchema } from '../desktop-preferences/desktop-preferences.dto';
import type { LocalBackupSnapshot } from './system-backups.service';
import { timeMachineIssue } from './time-machine-policy';

async function copiedJson(snapshot: LocalBackupSnapshot, name: string) {
  // Only inventory-bound files inside this immutable copied snapshot may supply a preview.
  if (!snapshot.files.some((file) => file.name === name)) return undefined;
  const handle = await fs.open(path.join(snapshot.content, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 131_072) throw new Error('Unsupported preview metadata.');
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function historicalHomePreview(snapshot: LocalBackupSnapshot, ownerId: number): Promise<TimeMachinePreview> {
  try {
    const desktop = await copiedJson(snapshot, `data/state/desktop/${ownerId}.json`);
    if (desktop === undefined) return { available: false, reason: timeMachineIssue('preview-not-captured') };
    const parsed = desktopPreferencesSchema(desktop);
    if (parsed instanceof type.errors) return { available: false, reason: timeMachineIssue('preview-invalid') };
    const registry = await copiedJson(snapshot, `data/state/theme-packs/${ownerId}/registry.json`);
    const themes = registry === undefined ? undefined : themePackStateSchema.assert(registry);
    const selected = themes?.installed.find((item) => item.manifest.id === themes.selected?.id && item.manifest.version === themes.selected.version);
    if (selected && createHash('sha256').update(JSON.stringify(selected.manifest)).digest('hex') !== selected.digest)
      return { available: false, reason: timeMachineIssue('preview-invalid') };
    const result = timeMachinePreviewSchema({
      available: true,
      kind: 'historical-home-projection',
      version: 1,
      capturedAt: snapshot.createdAt,
      desktop: {
        serverName: parsed.serverName,
        preset: parsed.preset,
        mode: parsed.mode ?? (parsed.preset === 'graphite' ? 'dark' : 'light'),
        density: parsed.density,
        wallpaper: parsed.wallpaper ?? 'sandstone',
        wallpaperMode: parsed.wallpaperMode ?? (parsed.wallpaperPreset || parsed.appearance?.wallpaperImage ? 'custom' : 'theme'),
        wallpaperPreset: parsed.wallpaperPreset ?? null,
        appearance: normaliseDesktopAppearance(parsed.appearance),
        workspace: {
          order: parsed.workspace?.order ?? ['applications', 'activity', 'storage', 'attention'],
          hidden: parsed.workspace?.hidden ?? [],
          wide: parsed.workspace?.wide ?? ['applications'],
          showAllApps: parsed.workspace?.showAllApps ?? false,
          pinnedApps: parsed.workspace?.pinnedApps ?? [],
        },
      },
      theme: selected?.manifest ?? null,
      customWallpaperAvailable: false,
      wallpaperAsset: {
        available: false,
        identity: parsed.appearance?.wallpaperImage ?? selected?.manifest.wallpaper ?? null,
        reason: timeMachineIssue('historical-assets-unavailable'),
      },
      screenshot: { available: false, reason: timeMachineIssue('screenshot-not-captured') },
      resolvedSystemMode: null,
      apps: snapshot.apps,
    });
    return result instanceof type.errors ? { available: false, reason: timeMachineIssue('preview-invalid') } : result;
  } catch {
    return { available: false, reason: timeMachineIssue('preview-invalid') };
  }
}

export function captureBreakdown(snapshot: LocalBackupSnapshot) {
  const groups = new Map<string, { id: string; bytes: number; entries: number }>();
  for (const file of snapshot.files) {
    const id = file.name.startsWith('app-data/') ? 'app-data' : (file.name.split('/')[1] ?? 'configuration');
    const entry = groups.get(id) ?? { id, bytes: 0, entries: 0 };
    entry.bytes += file.bytes;
    entry.entries++;
    groups.set(id, entry);
  }
  return [{ id: 'database', bytes: snapshot.databaseBytes, entries: 1 }, ...groups.values()];
}

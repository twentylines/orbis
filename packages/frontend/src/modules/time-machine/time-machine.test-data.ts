import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { defaultDesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import type { TimeMachineRestoreReview } from '@runtipi/common/schemas/time-machine-restore';

export const fixturePointId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export function historicalPoint(): TimeMachinePoint {
  const createdAt = Date.UTC(2026, 9, 31);
  return {
    id: fixturePointId,
    createdAt,
    status: 'sealed',
    stage: 'complete',
    completedBytes: 100,
    totalBytes: 100,
    issue: null,
    backupJobId: null,
    metadata: {
      version: 1,
      id: fixturePointId,
      createdAt,
      label: 'Before update',
      source: 'manual',
      archiveBytes: 100,
      archiveSha256: 'a'.repeat(64),
      manifestSha256: 'b'.repeat(64),
      software: { orbis: '0.5 beta 1', runtipi: '4.10.1', architecture: 'arm64' },
      coverage: {
        database: true,
        configuration: true,
        appData: true,
        appearance: true,
        dockerImages: false,
        controllerVersion: false,
        cluster: 'local-only',
      },
      restore: { ready: false, blockers: [{ code: 'activation-not-integrated', message: 'Restoration is unavailable.' }] },
      preview: {
        available: true,
        kind: 'historical-home-projection',
        version: 1,
        capturedAt: createdAt,
        desktop: {
          serverName: 'Saved server',
          preset: 'forest',
          mode: 'light',
          density: 'comfortable',
          wallpaper: 'canopy',
          wallpaperMode: 'theme',
          wallpaperPreset: 'forest',
          appearance: { ...defaultDesktopAppearance },
          workspace: { order: ['applications', 'activity'], hidden: [], wide: ['applications'], showAllApps: true, pinnedApps: [] },
        },
        theme: null,
        customWallpaperAvailable: false,
        wallpaperAsset: {
          available: false,
          identity: null,
          reason: { code: 'historical-assets-unavailable', message: 'No point-bound wallpaper was captured.' },
        },
        screenshot: { available: false, reason: { code: 'screenshot-not-captured', message: 'No screenshot was captured.' } },
        resolvedSystemMode: null,
        apps: [{ urn: 'store:notes', name: 'Saved Notes', running: true }],
      },
      breakdown: [{ id: 'data', bytes: 100, entries: 2 }],
      excludedApps: [],
    },
  };
}
export function readyReview(): TimeMachineRestoreReview {
  return {
    version: 1,
    pointId: fixturePointId,
    reviewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    archiveSha256: 'a'.repeat(64),
    manifestSha256: 'b'.repeat(64),
    machineId: 'c'.repeat(64),
    status: 'ready',
    ready: true,
    expiresAt: 10_000,
    blockers: [],
    progress: { stage: 'ready', completedBytes: 100, totalBytes: 100 },
  };
}

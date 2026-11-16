import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { toolbarActionIds } from '@runtipi/common/schemas/workspace-layout';
import { timeMachinePreviewSchema } from '@runtipi/common/schemas/time-machine';
import { DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { historicalHomePreview } from './time-machine-preview';
import type { LocalBackupSnapshot } from './system-backups.service';

it('preserves custom layout and toolbar from copied preferences into a serialized Time Machine projection', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-workspace-projection-'));
  try {
    const name = 'data/state/desktop/7.json';
    const layout = { version: 1, appView: 'icons', widgets: { activity: { columns: 3, height: 480 }, 'future-widget': { columns: 2, height: 320 } } };
    const toolbarOrder = [...toolbarActionIds].reverse();
    const preferences = { ...DEFAULT_DESKTOP_PREFERENCES, toolbarOrder, workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, layout } };
    await fs.mkdir(path.join(directory, 'data/state/desktop'), { recursive: true });
    await fs.writeFile(path.join(directory, name), JSON.stringify(preferences));
    const snapshot: LocalBackupSnapshot = {
      content: directory,
      createdAt: Date.now(),
      manifestSha256: 'a'.repeat(64),
      software: { orbis: 'fixture', runtipi: 'fixture', architecture: 'arm64' },
      files: [{ name, bytes: 1 }],
      databaseBytes: 0,
      apps: [],
    };
    const projection = await historicalHomePreview(snapshot, 7);
    expect(projection.available).toBe(true);
    expect(timeMachinePreviewSchema.assert(JSON.parse(JSON.stringify(projection)))).toMatchObject({
      desktop: { toolbarOrder, workspace: { layout } },
    });
    await fs.writeFile(path.join(directory, name), JSON.stringify(DEFAULT_DESKTOP_PREFERENCES));
    const legacy = await historicalHomePreview(snapshot, 7);
    expect(legacy.available).toBe(true);
    if (legacy.available) {
      expect(legacy.desktop.workspace).not.toHaveProperty('layout');
      expect(legacy.desktop).not.toHaveProperty('toolbarOrder');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

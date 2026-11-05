import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { splitSettingsPreferences } from './settings-backup-preferences';
import { readSettingsJsonPart, writeSettingsJsonPart } from './settings-backup-json-parts';
import { exportSettingsBundle, importSettingsBundle } from './settings-backup-format';
import { stabilizeDarwinFixtureCreation } from './darwin-files.fixture';

let root: string;
let unpatch: () => void;
const passphrase = 'disposable settings backup passphrase';
const signal = () => new AbortController().signal;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'settings-payload-')));
  unpatch = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  unpatch();
  await fs.rm(root, { recursive: true, force: true });
});

it('round trips real validated settings and dashboard parts through the encrypted bundle', async () => {
  const prefs = splitSettingsPreferences({ ...structuredClone(DEFAULT_DESKTOP_PREFERENCES), serverName: 'Saved display name' });
  const values = {
    settings: { version: 1, server: { timeZone: 'UTC', allowAutoThemes: true }, desktop: prefs.settings },
    dashboard: { version: 1, desktop: prefs.dashboard },
  };
  const parts = [];
  for (const kind of ['settings', 'dashboard'] as const)
    parts.push(
      await writeSettingsJsonPart({ kind, value: values[kind], destination: path.join(root, `${kind}.orbis`), passphrase, signal: signal() }),
    );
  const destination = path.join(root, 'portable.orbis-settings');
  await exportSettingsBundle({
    directory: path.join(root, 'pack'),
    destination,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: 'v0.6.1-beta.3',
    parts,
    passphrase,
    signal: signal(),
  });
  expect((await fs.readFile(destination)).includes(Buffer.from('Saved display name'))).toBe(false);
  const opened = await importSettingsBundle({ directory: path.join(root, 'review'), source: destination, passphrase, signal: signal() });
  try {
    for (const part of opened.parts) {
      if (part.kind !== 'settings' && part.kind !== 'dashboard') throw new Error('Wrong fixture part');
      expect(await readSettingsJsonPart({ ...part, kind: part.kind, passphrase, signal: signal() })).toEqual(values[part.kind]);
    }
  } finally {
    await opened.dispose();
  }
});

it('rejects invalid or cross-category data before creating an export file', async () => {
  for (const value of [
    { version: 1, server: { password: 'not a supported setting' }, desktop: {} },
    { version: 1, server: { themeColor: '#aabbcc' }, desktop: {} },
    { version: 1, server: {}, desktop: { preset: 'forest' } },
  ]) {
    const destination = path.join(root, randomUUID());
    await expect(writeSettingsJsonPart({ kind: 'settings', value, destination, passphrase, signal: signal() })).rejects.toThrow();
    await expect(fs.lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('rejects changed ciphertext and wrong keys without applying any preferences', async () => {
  const part = await writeSettingsJsonPart({
    kind: 'dashboard',
    value: { version: 1, desktop: { density: 'compact' } },
    destination: path.join(root, 'part.orbis'),
    passphrase,
    signal: signal(),
  });
  await expect(readSettingsJsonPart({ ...part, passphrase: 'another valid length key', signal: signal() })).rejects.toThrow();
  const bytes = await fs.readFile(part.file);
  bytes[45] = (bytes[45] ?? 0) ^ 1;
  await fs.writeFile(part.file, bytes);
  await expect(readSettingsJsonPart({ ...part, passphrase, signal: signal() })).rejects.toThrow();
});

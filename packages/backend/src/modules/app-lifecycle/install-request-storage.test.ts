import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { BackupRuntimeService } from '@/modules/system-backups/backup-runtime.service';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  hasInstallRequestHold,
  installRequestDirectory,
  reserveInstallRequest,
  takeInstallRequestReceipt,
  verifyInstallRequestOwnership,
} from './install-request-receipt';

let root: string;
const urn = createAppUrn('fixture', 'catalogue');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-install-store-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('keeps legacy absence clear only while the configured data root exists', async () => {
  await expect(hasInstallRequestHold(root, urn)).resolves.toBe(false);
  await expect(hasInstallRequestHold(path.join(root, 'missing'), urn)).rejects.toMatchObject({ code: 'ENOENT' });
  const directory = installRequestDirectory(root, urn);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await expect(hasInstallRequestHold(root, urn)).resolves.toBe(false);
  await fs.writeFile(path.join(directory, 'pending'), '', { mode: 0o600 });
  await expect(hasInstallRequestHold(root, urn)).resolves.toBe(true);
});

it('does not restart a held app when its data mount disappears', async () => {
  const dataDir = path.join(root, 'data');
  const directory = installRequestDirectory(dataDir, urn);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'pending'), '', { mode: 0o600 });
  await fs.rename(dataDir, path.join(root, 'disconnected'));
  const start = vi.fn();
  const handle = {
    start,
    inspect: async () => ({ Config: { Labels: { 'com.docker.compose.project': 'fixture_catalogue' } }, State: { Running: false } }),
  };
  const runtime = new BackupRuntimeService({ get: () => ({ dataDir }) } as never, { getContainer: () => handle } as never);
  await expect(runtime.resume([{ id: 'fixture-id', project: 'fixture_catalogue', running: true }])).rejects.toThrow('could not be restarted');
  expect(start).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(root, 'disconnected', path.relative(dataDir, directory)))).toEqual(['pending']);
});

it('refuses an empty replacement observed through a pathname after opening the held directory', async () => {
  const directory = installRequestDirectory(root, urn);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'pending'), '', { mode: 0o600 });
  const opendir = fs.opendir.bind(fs);
  vi.spyOn(fs, 'opendir').mockImplementationOnce(async (name) => {
    await fs.rename(directory, `${directory}-original`);
    await fs.mkdir(directory, { mode: 0o700 });
    return opendir(name);
  });
  await expect(hasInstallRequestHold(root, urn)).rejects.toThrow('changed');
  expect(await fs.readdir(`${directory}-original`)).toEqual(['pending']);
});

it('requires the recorded receipt directory snapshot to retain private permissions', async () => {
  const directory = installRequestDirectory(root, urn);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const open = fs.open.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (name, ...args) => {
    const handle = await open(name, ...args);
    if (name === directory && !changed) {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce((async () => {
        const before = await stat();
        await fs.chmod(directory, 0o755);
        changed = true;
        return before;
      }) as typeof handle.stat);
    }
    return handle;
  });
  await expect(hasInstallRequestHold(root, urn)).rejects.toThrow('storage is unavailable');
  expect(changed).toBe(true);
});

async function owned() {
  const request = { requestId: randomUUID(), owner: randomUUID(), skipRun: false };
  const app = { id: 7, createdAt: 123, appName: 'fixture', appStoreSlug: 'catalogue' };
  await reserveInstallRequest(root, urn, request, async () => app);
  const cleanup = await takeInstallRequestReceipt(root, { ...request, app });
  if (!cleanup) throw new Error('Missing claimed request');
  const directory = installRequestDirectory(root, urn);
  const entry = (await fs.readdir(directory)).find((name) => name.startsWith('spent-'));
  if (!entry) throw new Error('Missing spent receipt');
  return {
    cleanup,
    ownership: cleanup.ownership,
    request,
    app,
    directory,
    spentDirectory: path.join(directory, entry),
    spent: path.join(directory, entry, request.requestId),
  };
}
it('retains live request ownership after claiming and expires it only when spent custody is removed', async () => {
  const value = await owned();
  expect(await verifyInstallRequestOwnership(value.ownership, urn, value.request.requestId)).toEqual(value.app);
  expect(Object.isFrozen(value.ownership)).toBe(true);
  expect(Object.isFrozen(value.ownership.reservation)).toBe(true);
  expect(await hasInstallRequestHold(root, urn)).toBe(true);
  await value.cleanup();
  await expect(verifyInstallRequestOwnership(value.ownership, urn, value.request.requestId)).rejects.toThrow();
  expect(await hasInstallRequestHold(root, urn)).toBe(false);
});
it('rejects a copied or deserialized claim and mismatched request or app identities', async () => {
  const value = await owned();
  for (const copy of [{ ...value.ownership }, JSON.parse(JSON.stringify(value.ownership))])
    await expect(verifyInstallRequestOwnership(copy, urn, value.request.requestId)).rejects.toThrow();
  await expect(verifyInstallRequestOwnership(value.ownership, urn, randomUUID())).rejects.toThrow();
  await expect(verifyInstallRequestOwnership(value.ownership, createAppUrn('other', 'catalogue'), value.request.requestId)).rejects.toThrow();
  expect(await verifyInstallRequestOwnership(value.ownership, urn, value.request.requestId)).toEqual(value.app);
});
it.each(['bytes', 'replacement', 'link', 'permissions', 'original-name', 'extra-entry', 'parent'] as const)(
  'keeps custody and refuses a changed claimed receipt: %s',
  async (fault) => {
    const value = await owned();
    if (fault === 'bytes') await fs.writeFile(value.spent, 'changed');
    if (fault === 'replacement') {
      const replacement = path.join(root, 'replacement');
      await fs.writeFile(replacement, await fs.readFile(value.spent), { mode: 0o600 });
      await fs.rename(replacement, value.spent);
    }
    if (fault === 'link') await fs.link(value.spent, path.join(root, 'alias'));
    if (fault === 'permissions') await fs.chmod(value.spent, 0o644);
    if (fault === 'original-name') await fs.writeFile(path.join(value.directory, value.request.requestId), 'changed');
    if (fault === 'extra-entry') await fs.writeFile(path.join(value.spentDirectory, 'unexpected'), 'kept');
    if (fault === 'parent') {
      await fs.rename(value.spentDirectory, value.spentDirectory + '-retained');
      await fs.mkdir(value.spentDirectory, { mode: 0o700 });
      await fs.writeFile(value.spent, 'replacement');
    }
    await expect(verifyInstallRequestOwnership(value.ownership, urn, value.request.requestId)).rejects.toThrow();
    await expect(value.cleanup()).rejects.toThrow();
    expect(await hasInstallRequestHold(root, urn)).toBe(true);
    expect(await fs.lstat(value.spent)).toBeTruthy();
  },
);

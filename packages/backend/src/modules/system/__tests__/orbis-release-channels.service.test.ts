import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationService } from '@/core/config/configuration.service';
import { OrbisReleaseChannelsService } from '../orbis-release-channels.service';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { fsMock } = await import('../../../tests/__mocks__/fs');
  return { ...fsMock, constants: actual.constants };
});

const revision = 'a65a9a64-f57e-4c73-9dc8-8d35d0b5b5a1';

describe('OrbisReleaseChannelsService private read state', () => {
  let root: string;
  let state: string;
  let file: string;
  let service: OrbisReleaseChannelsService;
  let originalOrbisVersion: string | undefined;

  const record = (channel = 'nightly', version: unknown = 1, id = revision) => ({ version, channel, revision: id });
  const writeRecord = async (value: unknown) => {
    await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
    await fs.chmod(file, 0o600);
  };
  const expectUnavailable = async () => {
    await expect(service.read()).rejects.toBeInstanceOf(ServiceUnavailableException);
  };

  beforeEach(async () => {
    originalOrbisVersion = process.env.ORBIS_VERSION;
    delete process.env.ORBIS_VERSION;
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-release-channel-test-')));
    await fs.chmod(root, 0o700);
    state = path.join(root, 'state');
    file = path.join(state, 'orbis-release-channel.json');
    await fs.mkdir(state, { mode: 0o700 });
    service = new OrbisReleaseChannelsService({
      get: vi.fn(() => ({ dataDir: root })),
    } as unknown as ConfigurationService);
  });

  afterEach(async () => {
    if (originalOrbisVersion === undefined) delete process.env.ORBIS_VERSION;
    else process.env.ORBIS_VERSION = originalOrbisVersion;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('defaults missing state and a missing file to Stable without creating either', async () => {
    expect(await fs.realpath(state)).toBe(state);
    expect((await fs.lstat(state)).isDirectory()).toBe(true);
    const initial = await service.read();
    expect(initial).toEqual({ version: 1, channel: 'stable', revision: 'initial' });
    expect(await fs.readdir(state)).toEqual([]);

    await fs.rm(state, { recursive: true });
    expect(await service.read()).toEqual({ version: 1, channel: 'stable', revision: 'initial' });
    await expect(fs.lstat(state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads a valid private Nightly record without rewriting its bytes or metadata', async () => {
    await writeRecord(record());
    const beforeBytes = await fs.readFile(file);
    const beforeStat = await fs.stat(file);

    await expect(service.read()).resolves.toEqual(record());

    const afterStat = await fs.stat(file);
    expect(await fs.readFile(file)).toEqual(beforeBytes);
    expect(afterStat.ino).toBe(beforeStat.ino);
    expect(afterStat.mode & 0o777).toBe(beforeStat.mode & 0o777);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it.each([0o755, 0o775, 0o777])('supports a fresh legacy state directory mode %o without modifying its permissions', async (mode) => {
    await fs.chmod(state, mode);
    await expect(service.read()).resolves.toEqual({ version: 1, channel: 'stable', revision: 'initial' });
    expect(await fs.readdir(state)).toEqual([]);
    expect((await fs.stat(state)).mode & 0o777).toBe(mode);
  });

  it.each([0o700, 0o755, 0o775, 0o777])('reads protected policy state inside a migrated parent mode %o', async (mode) => {
    await fs.chmod(state, mode);
    const policy = path.join(state, 'orbis-update-policy');
    await fs.mkdir(policy, { mode: 0o700 });
    await fs.writeFile(path.join(policy, 'channel.json'), JSON.stringify(record()), { mode: 0o600 });
    await expect(service.read()).resolves.toEqual(record());
    expect((await fs.stat(state)).mode & 0o777).toBe(mode);
  });

  it('uses the protected policy after migrating a legacy record, without deleting legacy data', async () => {
    await writeRecord(record('stable'));
    const policy = path.join(state, 'orbis-update-policy');
    await fs.mkdir(policy, { mode: 0o700 });
    await fs.writeFile(path.join(policy, 'channel.json'), JSON.stringify(record('nightly')), { mode: 0o600 });
    await expect(service.read()).resolves.toEqual(record('nightly'));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(record('stable'));
  });

  it.each([0o755, 0o775, 0o777])('rejects a nonprivate policy directory mode %o', async (mode) => {
    const policy = path.join(state, 'orbis-update-policy');
    await fs.mkdir(policy, { mode: 0o700 });
    await fs.chmod(policy, mode);
    await expectUnavailable();
  });

  it('rejects a policy-directory symlink instead of treating it as an unconfigured installation', async () => {
    const target = path.join(root, 'policy-target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, path.join(state, 'orbis-update-policy'));
    await expectUnavailable();
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('requires stable installation for a Nightly beta, but not for Stable', async () => {
    await writeRecord(record('nightly'));
    process.env.ORBIS_VERSION = 'v1.0.1-beta.1';
    await expect(service.status()).resolves.toMatchObject({ current: 'nightly', installedVersion: 'v1.0.1-beta.1', requiresStableInstall: true });

    await writeRecord(record('stable'));
    await expect(service.status()).resolves.toMatchObject({ current: 'stable', installedVersion: 'v1.0.1-beta.1', requiresStableInstall: false });
  });

  it('does not follow a state-directory symlink or alter its target', async () => {
    const targetDirectory = path.join(root, 'protected-state');
    await fs.mkdir(targetDirectory, { mode: 0o700 });
    const targetFile = path.join(targetDirectory, 'orbis-release-channel.json');
    const original = JSON.stringify(record());
    await fs.writeFile(targetFile, original, { mode: 0o600 });
    await fs.rm(state, { recursive: true });
    await fs.symlink(targetDirectory, state);

    await expectUnavailable();
    expect(await fs.readFile(targetFile, 'utf8')).toBe(original);
    expect((await fs.lstat(state)).isSymbolicLink()).toBe(true);
  });

  it('does not follow a channel-file symlink or alter its target', async () => {
    const target = path.join(root, 'protected.json');
    const original = JSON.stringify(record());
    await fs.writeFile(target, original, { mode: 0o600 });
    await fs.symlink(target, file);

    await expectUnavailable();
    expect(await fs.readFile(target, 'utf8')).toBe(original);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
  });

  it('rejects hard-linked state and preserves both names', async () => {
    const other = path.join(root, 'protected.json');
    const original = JSON.stringify(record());
    await fs.writeFile(other, original, { mode: 0o600 });
    await fs.link(other, file);

    await expectUnavailable();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await fs.readFile(other, 'utf8')).toBe(original);
    expect((await fs.stat(file)).nlink).toBe(2);
  });

  it('rejects a publicly readable channel file and preserves its bytes', async () => {
    const original = JSON.stringify(record());
    await fs.writeFile(file, original, { mode: 0o644 });
    await fs.chmod(file, 0o644);

    await expectUnavailable();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.stat(file)).mode & 0o077).not.toBe(0);
  });

  it('accepts a 0755 state directory when its channel file remains private', async () => {
    const original = JSON.stringify(record());
    await writeRecord(record());
    await fs.chmod(state, 0o755);

    await expect(service.read()).resolves.toEqual(record());
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.stat(state)).mode & 0o777).toBe(0o755);
  });

  it.each([0o775, 0o777])('rejects a group/world-writable state directory mode %o and preserves its file', async (mode) => {
    const original = JSON.stringify(record());
    await writeRecord(record());
    await fs.chmod(state, mode);

    await expectUnavailable();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect((await fs.stat(state)).mode & 0o777).toBe(mode);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['oversized JSON', JSON.stringify(record()).padEnd(4097, ' ')],
    ['extra fields', JSON.stringify({ ...record(), comment: 'not allowed' })],
    ['array channel', JSON.stringify({ ...record(), channel: ['nightly'] })],
    ['invalid record version', JSON.stringify(record('nightly', 2))],
    ['invalid revision UUID', JSON.stringify(record('nightly', 1, 'not-a-v4-uuid'))],
  ])('rejects %s without rewriting saved data', async (_label, contents) => {
    await fs.writeFile(file, contents, { mode: 0o600 });
    await fs.chmod(file, 0o600);
    const original = await fs.readFile(file);

    await expectUnavailable();

    expect(await fs.readFile(file)).toEqual(original);
  });
});

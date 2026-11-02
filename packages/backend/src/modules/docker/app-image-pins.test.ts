import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  beginAppImagePinUpdate,
  requireAppImagePinUpdate,
  requireNoAppImagePinUpdates,
  appImagePinSourceSha256,
  readAppImagePins,
  removeAppImagePins,
  writeAppImagePins,
} from './app-image-pins';

const source = { appUrn: 'app:test', project: 'app_test', sourceSha256: 'a'.repeat(64) };
const image = `sha256:${'9'.repeat(64)}`;
const input = { version: 1 as const, pointId: '12345678-1234-4123-8123-123456789abc', sourceSha256: source.sourceSha256, services: { web: image } };
let root: string;
let directory: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'app-image-pins-')));
  directory = path.join(root, 'pins');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('retained app image pins', () => {
  it('never creates directories on an ordinary missing-pin read', async () => {
    expect(await readAppImagePins(directory, source)).toBeNull();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('atomically persists one private Compose overlay with bound metadata and immutable images', async () => {
    const saved = await writeAppImagePins(directory, source, input);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual([path.basename(saved.path)]);
    expect(JSON.parse(await fs.readFile(saved.path, 'utf8')).services).toEqual({ web: { image, pull_policy: 'never' } });
    expect((await readAppImagePins(directory, source))?.pins).toEqual({ ...input, ...source });
    await writeAppImagePins(directory, source, { ...input, services: { web: `sha256:${'b'.repeat(64)}` } });
    expect((await readAppImagePins(directory, source))?.pins.services.web).toBe(`sha256:${'b'.repeat(64)}`);
  });
  it('rejects changed source, unknown fields, mutable refs, unsafe services and app selectors', async () => {
    const saved = await writeAppImagePins(directory, source, input);
    await expect(readAppImagePins(directory, { ...source, sourceSha256: 'b'.repeat(64) })).rejects.toThrow();
    for (const bad of [
      { ...input, services: { web: 'nginx:latest' } },
      { ...input, services: { '../web': image } },
      { ...input, extra: true },
    ])
      await expect(writeAppImagePins(directory, source, bad as never)).rejects.toThrow();
    await expect(writeAppImagePins(directory, { ...source, appUrn: '../app:test' }, input)).rejects.toThrow();
    const record = JSON.parse(await fs.readFile(saved.path, 'utf8'));
    record['x-orbis-image-pin'].services = {};
    await fs.writeFile(saved.path, JSON.stringify(record));
    await expect(readAppImagePins(directory, source)).rejects.toThrow();
  });
  it('rejects symlink ancestors, symlink overlays, hard links and public permissions', async () => {
    const target = path.join(root, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, directory);
    await expect(writeAppImagePins(directory, source, input)).rejects.toThrow();
    await fs.unlink(directory);
    const saved = await writeAppImagePins(directory, source, input);
    const file = path.join(root, 'copy');
    await fs.rename(saved.path, file);
    await fs.symlink(file, saved.path);
    await expect(readAppImagePins(directory, source)).rejects.toThrow();
    await fs.unlink(saved.path);
    await fs.link(file, saved.path);
    await expect(readAppImagePins(directory, source)).rejects.toThrow();
    await fs.unlink(file);
    await fs.chmod(saved.path, 0o644);
    await expect(readAppImagePins(directory, source)).rejects.toThrow();
  });
  it('bounds service inventories and rejects oversized stored overlays before parsing', async () => {
    const services = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`service${index}`, image]));
    await expect(writeAppImagePins(directory, source, { ...input, services })).rejects.toThrow();
    const saved = await writeAppImagePins(directory, source, input);
    await fs.writeFile(saved.path, ' '.repeat(128 * 1024 + 1));
    await expect(readAppImagePins(directory, source)).rejects.toThrow();
  });
  it('retires only the selected app overlay and leaves sibling app pins intact', async () => {
    await writeAppImagePins(directory, source, input);
    const other = { ...source, appUrn: 'other:test', project: 'other_test' };
    await writeAppImagePins(directory, other, input);
    await removeAppImagePins(directory, source.appUrn);
    expect(await readAppImagePins(directory, source)).toBeNull();
    expect((await readAppImagePins(directory, other))?.pins.appUrn).toBe(other.appUrn);
  });
  it('binds both source content and enabled user overrides with stable object ordering', () => {
    const first = appImagePinSourceSha256({ services: { web: { image: 'a', port: 80 } } }, 'services: {}');
    expect(appImagePinSourceSha256({ services: { web: { port: 80, image: 'a' } } }, 'services: {}')).toBe(first);
    expect(appImagePinSourceSha256({ services: { web: { image: 'b', port: 80 } } }, 'services: {}')).not.toBe(first);
    expect(appImagePinSourceSha256({ services: { web: { image: 'a', port: 80 } } }, null)).not.toBe(first);
  });
});

describe('retained update metadata barrier', () => {
  const fixture = async () => {
    const metadata = path.join(root, 'installed');
    const data = path.join(root, 'app-data');
    const env = path.join(data, 'app.env');
    await fs.mkdir(metadata, { mode: 0o750 });
    await fs.mkdir(data, { mode: 0o700 });
    await fs.writeFile(path.join(metadata, 'source.json'), 'old-source', { mode: 0o640 });
    await fs.writeFile(env, 'OLD_SETTING=kept', { mode: 0o600 });
    await fs.writeFile(path.join(data, 'accepted-write'), 'original-data');
    return { metadata, data, env };
  };
  it('restores only sealed metadata and original permissions before activation, leaving app data untouched', async () => {
    const f = await fixture();
    const transaction = await beginAppImagePinUpdate(directory, source.appUrn, f.metadata, f.env);
    await expect(requireAppImagePinUpdate(directory, source.appUrn)).rejects.toThrow('explicit recovery');
    await fs.writeFile(path.join(f.metadata, 'source.json'), 'new-source');
    await fs.writeFile(f.env, 'NEW_SETTING=changed');
    await transaction.prepare();
    await transaction.restoreMetadata();
    expect(await fs.readFile(path.join(f.metadata, 'source.json'), 'utf8')).toBe('old-source');
    expect((await fs.stat(path.join(f.metadata, 'source.json'))).mode & 0o777).toBe(0o640);
    expect(await fs.readFile(f.env, 'utf8')).toBe('OLD_SETTING=kept');
    expect(await fs.readFile(path.join(f.data, 'accepted-write'), 'utf8')).toBe('original-data');
    await expect(requireNoAppImagePinUpdates(directory)).resolves.toBeUndefined();
  });
  it('durably blocks ordinary operations after activation and preserves any accepted new writes', async () => {
    const f = await fixture();
    const transaction = await beginAppImagePinUpdate(directory, source.appUrn, f.metadata, f.env);
    await fs.writeFile(path.join(f.metadata, 'source.json'), 'new-source');
    await fs.writeFile(f.env, 'NEW_SETTING=changed');
    await transaction.prepare();
    await transaction.activationAttempted();
    await fs.writeFile(path.join(f.data, 'accepted-write'), 'accepted-new-data');
    await expect(transaction.restoreMetadata()).rejects.toThrow('explicit recovery');
    await expect(requireAppImagePinUpdate(directory, source.appUrn)).rejects.toThrow('explicit recovery');
    await expect(requireNoAppImagePinUpdates(directory)).rejects.toThrow('explicit recovery');
    expect(await fs.readFile(path.join(f.metadata, 'source.json'), 'utf8')).toBe('new-source');
    expect(await fs.readFile(f.env, 'utf8')).toBe('NEW_SETTING=changed');
    expect(await fs.readFile(path.join(f.data, 'accepted-write'), 'utf8')).toBe('accepted-new-data');
    const guard = await requireAppImagePinUpdate(directory, source.appUrn, transaction.id);
    expect(guard?.phase).toBe('activation-attempted');
    await expect(requireAppImagePinUpdate(directory, 'other:test')).resolves.toBeNull();
  });
  it('cleans only owned partial staging when unsafe metadata fails before the mutation guard', async () => {
    const f = await fixture();
    await fs.symlink(path.join(f.data, 'accepted-write'), path.join(f.metadata, 'untrusted-link'));
    await expect(beginAppImagePinUpdate(directory, source.appUrn, f.metadata, f.env)).rejects.toThrow('explicit recovery');
    expect(await fs.readdir(directory)).toEqual([]);
    expect(await fs.readFile(path.join(f.data, 'accepted-write'), 'utf8')).toBe('original-data');
  });
  it('retires the selected pin and clears the durable guard only on committed success', async () => {
    const f = await fixture();
    await writeAppImagePins(directory, source, input);
    const transaction = await beginAppImagePinUpdate(directory, source.appUrn, f.metadata, f.env);
    await fs.writeFile(path.join(f.metadata, 'source.json'), 'new-source');
    await fs.writeFile(f.env, 'NEW_SETTING=changed');
    await transaction.prepare();
    await transaction.activationAttempted();
    await fs.writeFile(path.join(f.data, 'accepted-write'), 'accepted-new-data');
    await transaction.commit(() => removeAppImagePins(directory, source.appUrn));
    expect(await readAppImagePins(directory, source)).toBeNull();
    await expect(requireNoAppImagePinUpdates(directory)).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(f.metadata, 'source.json'), 'utf8')).toBe('new-source');
    expect(await fs.readFile(path.join(f.data, 'accepted-write'), 'utf8')).toBe('accepted-new-data');
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('retains recovery evidence if prepared metadata changed rather than overwriting it', async () => {
    const f = await fixture();
    const transaction = await beginAppImagePinUpdate(directory, source.appUrn, f.metadata, f.env);
    await fs.writeFile(path.join(f.metadata, 'source.json'), 'new-source');
    await transaction.prepare();
    await fs.writeFile(path.join(f.metadata, 'source.json'), 'accepted-metadata-edit');
    await expect(transaction.restoreMetadata()).rejects.toThrow('explicit recovery');
    expect(await fs.readFile(path.join(f.metadata, 'source.json'), 'utf8')).toBe('accepted-metadata-edit');
    await expect(requireAppImagePinUpdate(directory, source.appUrn)).rejects.toThrow('explicit recovery');
  });
});

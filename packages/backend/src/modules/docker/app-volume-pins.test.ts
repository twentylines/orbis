import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeAppVolumePins, encodeAppVolumePins, readAppVolumePins, writeAppVolumePins, type AppVolumePins } from './app-volume-pins';

const example = (): AppVolumePins => ({
  version: 1,
  appUrn: 'app:store',
  project: 'app_store',
  services: [
    {
      name: 'app',
      mounts: [
        { target: '/data', volume: 'restored-123', readOnly: false },
        { target: '/var/lib/store', volume: 'restored-456', readOnly: true },
      ],
    },
  ],
});
const firstService = (p: AppVolumePins) => {
  const value = p.services[0];
  if (!value) throw new Error('missing fixture service');
  return value;
};
const firstMount = (p: AppVolumePins) => {
  const value = firstService(p).mounts[0];
  if (!value) throw new Error('missing fixture mount');
  return value;
};
const roots: string[] = [];
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'volume-pins-'));
  roots.push(root);
  return path.join(root, 'app-volume-pins');
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('retained volume bindings', () => {
  it('preserves the existing custom-app store identity without accepting arbitrary underscored stores', async () => {
    const pins = { ...example(), appUrn: 'app:_user', project: 'app__user' };
    expect(decodeAppVolumePins(encodeAppVolumePins(pins))).toEqual(pins);
    const dir = await directory();
    await writeAppVolumePins(dir, pins);
    expect((await readAppVolumePins(dir, pins))?.pins).toEqual(pins);
    expect(() => encodeAppVolumePins({ ...pins, appUrn: 'app:_other', project: 'app__other' })).toThrow();
  });
  it('renders deterministic external volumes with explicit nocopy and access mode', () => {
    const data = encodeAppVolumePins(example());
    expect(decodeAppVolumePins(data)).toEqual(example());
    const compose = JSON.parse(data.toString());
    const key = (name: string) => `orbis_retained_${createHash('sha256').update(name).digest('hex')}`;
    expect(compose.services.app.volumes).toEqual([
      { type: 'volume', source: key('restored-123'), target: '/data', read_only: false, volume: { nocopy: true } },
      { type: 'volume', source: key('restored-456'), target: '/var/lib/store', read_only: true, volume: { nocopy: true } },
    ]);
    expect(compose.volumes).toEqual({
      [key('restored-123')]: { external: true, name: 'restored-123' },
      [key('restored-456')]: { external: true, name: 'restored-456' },
    });
  });
  it('rejects divergent replicas, noncanonical and dangerous names, targets, and bounds', () => {
    for (const mutation of [
      (p: AppVolumePins) => p.services.push(structuredClone(firstService(p))),
      (p: AppVolumePins) => firstService(p).mounts.reverse(),
      (p: AppVolumePins) => {
        firstService(p).mounts[1] = { target: '/data/child', volume: 'ok', readOnly: false };
      },
      (p: AppVolumePins) => {
        firstMount(p).volume = '${VOLUME}';
      },
      (p: AppVolumePins) => {
        firstMount(p).volume = 'name:bad';
      },
      ...['/', '/data/', '/proc/x', '/sys/x', '/dev/x', '/data/../etc', '/data\\bad', '/data:$X', 'relative', '/a\n'].map(
        (target) => (p: AppVolumePins) => {
          firstMount(p).target = target;
        },
      ),
      (p: AppVolumePins) => {
        firstMount(p).target = `/${'a'.repeat(4096)}`;
      },
      (p: AppVolumePins) => {
        p.services = Array.from({ length: 257 }, (_, i) => ({
          name: `s${String(i).padStart(3, '0')}`,
          mounts: [{ target: '/data', volume: 'ok', readOnly: false }],
        }));
      },
    ]) {
      const pins = example();
      mutation(pins);
      expect(() => encodeAppVolumePins(pins)).toThrow();
    }
  });
  it('rejects modified Compose, foreign identity, and malformed files rather than ignoring them', async () => {
    const dir = await directory();
    expect(await readAppVolumePins(dir, example())).toBeNull();
    const { path: file } = await writeAppVolumePins(dir, example());
    expect((await readAppVolumePins(dir, example()))?.pins).toEqual(example());
    const doc = JSON.parse((await fs.readFile(file)).toString());
    doc.services.app.volumes[0].volume.nocopy = false;
    await fs.writeFile(file, JSON.stringify(doc));
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
    await expect(writeAppVolumePins(dir, example())).rejects.toThrow();
    const foreign = example();
    foreign.appUrn = 'other:store';
    foreign.project = 'other_store';
    await fs.writeFile(file, encodeAppVolumePins(foreign));
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
    await fs.writeFile(file, '{');
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
  });
  it('rejects symlinked or insecure directories and files', async () => {
    const dir = await directory();
    const { path: file } = await writeAppVolumePins(dir, example());
    await fs.chmod(file, 0o644);
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
    await fs.chmod(file, 0o600);
    await fs.unlink(file);
    await fs.symlink('missing', file);
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
    await expect(writeAppVolumePins(dir, example())).rejects.toThrow();
    await fs.unlink(file);
    await fs.chmod(dir, 0o755);
    await expect(readAppVolumePins(dir, example())).rejects.toThrow();
    await fs.chmod(dir, 0o700);
    const alias = `${dir}-alias`;
    await fs.symlink(dir, alias);
    await expect(readAppVolumePins(alias, example())).rejects.toThrow();
  });
});

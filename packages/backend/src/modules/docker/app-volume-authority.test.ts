import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAppVolumeAuthority } from './app-volume-authority';
import { writeAppVolumePins } from './app-volume-pins';

vi.unmock('node:fs');

const identity = { appUrn: 'app:store', project: 'app_store' };
const pins = { version: 1 as const, ...identity, services: [{ name: 'app', mounts: [{ target: '/data', volume: 'restored', readOnly: false }] }] };
const schema = 'orbis.app-volume-authority.v1';
const fileName = `${createHash('sha256').update(identity.appUrn).digest('hex')}.json`;
let dataDir: string;
let authority: string;
let pinFile: string;
const mount = (target: string, options = 'ro,relatime', filesystem = 'ext4', id = 44) =>
  `${id} 1 8:1 / ${target.replace(/\\/g, '\\134').replace(/ /g, '\\040')} ${options} - ${filesystem} /dev/fixture ro`;
const observe = (mountInfo: string, requirement?: string) => ({ mountInfo, requirement });
const read = (mountInfo: string, requirement?: string) => readAppVolumeAuthority(dataDir, identity, observe(mountInfo, requirement));
async function index(files: Record<string, string>) {
  await fs.writeFile(
    path.join(authority, 'authority.json'),
    JSON.stringify({ schema, version: 1, generation: '12345678-1234-4123-8123-123456789abc', files }),
    { mode: 0o600 },
  );
  await fs.readFile(path.join(authority, 'authority.json'));
}
async function setup() {
  await fs.mkdir(authority, { mode: 0o700 });
  const saved = await writeAppVolumePins(path.join(authority, 'pins'), pins);
  pinFile = saved.path;
  const hash = createHash('sha256')
    .update(await fs.readFile(pinFile))
    .digest('hex');
  await index({ [fileName]: hash });
}

beforeEach(async () => {
  dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'volume-authority-')));
  authority = path.join(dataDir, 'orbis-volumes');
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('app volume authority', () => {
  it('returns null without creating state when no mount exists', async () => {
    expect(await read('')).toBeNull();
    expect(await fs.readdir(dataDir)).toEqual([]);
  });
  it('fails closed when the mount is required or its directory exists without a mount', async () => {
    await expect(read('', schema)).rejects.toThrow('App storage protection');
    await fs.mkdir(authority, { mode: 0o700 });
    await expect(read('')).rejects.toThrow('App storage protection');
  });
  it('returns null for an empty private index on an exact mount', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    await index({});
    expect(await read(mount(authority), schema)).toBeNull();
  });
  it('rejects none with a mounted authority and rejects unknown requirements', async () => {
    await setup();
    await expect(read(mount(authority), 'none')).rejects.toThrow('App storage protection');
    await expect(read(mount(authority), 'unknown')).rejects.toThrow('App storage protection');
  });
  it('reads a validated pin from an exact readonly persistent mount', async () => {
    await setup();
    const stored = await read(mount(authority), schema);
    expect(stored?.pins).toEqual(pins);
    expect(stored?.path).toBe(pinFile);
  });
  it.each([
    ['writable', () => mount(authority, 'rw,relatime')],
    ['ephemeral', () => mount(authority, 'ro,relatime', 'tmpfs')],
    ['nested', () => `${mount(authority)}\n${mount(`${authority}/pins`, 'ro', 'ext4', 45)}`],
    ['stacked', () => `${mount(authority)}\n${mount(authority, 'ro', 'ext4', 45)}`],
  ])('rejects %s mounts', async (_label, observed) => {
    await setup();
    await expect(read(observed())).rejects.toThrow('App storage protection');
  });
  it('rejects insecure authority and pin directories and a symlinked marker', async () => {
    await setup();
    await fs.chmod(authority, 0o755);
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await fs.chmod(authority, 0o700);
    await fs.chmod(path.join(authority, 'pins'), 0o755);
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await fs.chmod(path.join(authority, 'pins'), 0o700);
    await fs.rename(path.join(authority, 'authority.json'), path.join(authority, 'original.json'));
    await fs.symlink('original.json', path.join(authority, 'authority.json'));
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
  });
  it('rejects malformed or insecure index files', async () => {
    await setup();
    await fs.chmod(path.join(authority, 'authority.json'), 0o644);
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await fs.chmod(path.join(authority, 'authority.json'), 0o600);
    await fs.writeFile(path.join(authority, 'authority.json'), '{');
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await index({ unexpected: 'a'.repeat(64) });
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
  });
  it('rejects missing indexed, unindexed present and hash-mismatched pin files', async () => {
    await setup();
    await index({ [fileName]: 'a'.repeat(64) });
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await index({});
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
    await index({ [fileName]: 'a'.repeat(64) });
    await fs.unlink(pinFile);
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
  });
  it('rejects legacy pins in shared state both with and without an authority mount', async () => {
    await fs.mkdir(path.join(dataDir, 'state', 'app-volume-pins'), { recursive: true, mode: 0o700 });
    await expect(read('')).rejects.toThrow('App storage protection');
    await setup();
    await expect(read(mount(authority))).rejects.toThrow('App storage protection');
  });
});

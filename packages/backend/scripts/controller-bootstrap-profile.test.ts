import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve(import.meta.dir, '../../../scripts/orbis-controller-bootstrap-profile.mjs');
const code = 'export const fixture = true;';
const legacy = {
  schema: 'orbis.controller-overlay-startup.v1',
  version: 1,
  preserveNetworkAccess: true,
  preserveRunningApps: true,
  environment: 'ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS=1',
};
const current = { ...legacy, schema: 'orbis.controller-overlay-startup.v2', version: 2, updateBackupPolicy: 'none' };

// The distributed, bundled probe runs in a child with only its two read-only
// inputs substituted. No /app or /data fixture is created on the test host.
const preload = `
import fs from 'node:fs';
const files = new Map([
  ['/app/main.mjs', Buffer.from(${JSON.stringify(code)})],
  ['/app/controller-overlay-capability.json', Buffer.from(process.env.ORBIS_PROBE_CAPABILITY_FIXTURE)],
]);
const original = Object.fromEntries(['openSync', 'fstatSync', 'lstatSync', 'readSync', 'closeSync', 'existsSync']
  .map(name => [name, fs[name].bind(fs)]));
const descriptors = new Map();
let next = 9000;
const stats = (data) => ({ isFile: () => true, size: BigInt(data.length), dev: 1n, ino: 1n,
  mode: 33024n, uid: 0n, gid: 0n, mtimeNs: 1n, ctimeNs: 1n, nlink: 1n });
fs.openSync = (name, ...args) => {
  if (files.has(name)) { const id = next++; descriptors.set(id, { data: files.get(name), offset: 0 }); return id; }
  if (String(name).startsWith('/app/') || String(name).startsWith('/data/')) throw new Error('Unexpected probe input');
  return original.openSync(name, ...args);
};
fs.fstatSync = (fd, ...args) => descriptors.has(fd) ? stats(descriptors.get(fd).data) : original.fstatSync(fd, ...args);
fs.lstatSync = (name, ...args) => files.has(name) ? stats(files.get(name)) : original.lstatSync(name, ...args);
fs.readSync = (fd, buffer, ...args) => {
  if (!descriptors.has(fd)) return original.readSync(fd, buffer, ...args);
  const item = descriptors.get(fd), size = Math.min(buffer.length, item.data.length - item.offset);
  item.data.copy(buffer, 0, item.offset, item.offset + size); item.offset += size; return size;
};
fs.closeSync = (fd) => descriptors.has(fd) ? descriptors.delete(fd) : original.closeSync(fd);
fs.existsSync = (name) => files.has(name) || original.existsSync(name);
`;

function runProbe(capability: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'orbis-bootstrap-probe-'));
  try {
    const file = path.join(directory, 'inputs.mjs');
    writeFileSync(file, preload);
    return spawnSync('node', ['--experimental-sqlite', '--import', pathToFileURL(file).href, bundle], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS: '1',
        ORBIS_PROBE_CAPABILITY_FIXTURE: JSON.stringify(capability),
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([legacy, current])('the shipped probe reads the exact supported source capability $schema', (capability) => {
  const before = Date.now();
  const result = runProbe(capability);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const proof = JSON.parse(result.stdout);
  expect(proof).toEqual({
    schema: 'orbis.controller-bootstrap-profile.v1',
    profile: 'controller-preservation.v1',
    codeSha256: createHash('sha256').update(code).digest('hex'),
    observedAt: expect.any(Number),
  });
  expect(proof.observedAt).toBeGreaterThanOrEqual(before);
  expect(proof.observedAt).toBeLessThanOrEqual(Date.now());
});

test.each(
  [
    null,
    [],
    { ...legacy, updateBackupPolicy: 'none' },
    { ...legacy, version: 2 },
    { ...current, updateBackupPolicy: undefined },
    { ...current, updateBackupPolicy: 'automatic' },
    { ...current, preserveRunningApps: false },
    { ...current, preserveNetworkAccess: 1 },
    { ...current, unexpected: true },
  ].map((capability) => ({ capability })),
)('the shipped probe refuses an ambiguous or unsupported capability %#', ({ capability }) => {
  const result = runProbe(capability);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unsupported source capability');
});

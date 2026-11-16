import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';
import { stageCorePortableEnrollment } from './time-machine-core-portable-worker';
import { TimeMachineStore } from './time-machine-store';

const fixtures: Awaited<ReturnType<typeof coreCapsuleFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const f = await coreCapsuleFixture();
  fixtures.push(f);
  const exported = await f.capsules.startExport(1, f.request, f.credentials, f.point.id, f.passphrase);
  exported.start();
  await vi.waitFor(async () => expect((await f.capsules.list(1)).jobs.find((job) => job.id === exported.job.id)?.status).toBe('ready'), {
    timeout: 15000,
  });
  const input = path.join(f.root, 'worker-input');
  const output = path.join(f.root, 'worker-output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  const capsule = await fs.readFile(path.join(f.root, 'backups/capsules', exported.job.id, 'capsule.orbis-tm'));
  const master = randomBytes(32);
  const request = { operationId: randomUUID(), capsuleSha256: sha(capsule), ownerId: 17, keyId: sha(master), passphrase: f.passphrase };
  await fs.writeFile(path.join(input, 'capsule.orbis-tm'), capsule, { mode: 0o400 });
  await fs.writeFile(path.join(input, 'master-v1.key'), master, { mode: 0o400 });
  await fs.writeFile(path.join(input, 'request.json'), JSON.stringify(request), { mode: 0o400 });
  return { ...f, input, output, request, master };
}
it('authenticates genuine core bytes and stages a destination-owned rewrapped point without capture authority', async () => {
  const f = await fixture();
  const originalPoint = await fs.readFile(path.join(f.root, 'backups/time-machine/points', f.point.id, 'point.json'));
  const result = await stageCorePortableEnrollment({ input: f.input, output: f.output, signal: new AbortController().signal });
  expect(result).toMatchObject({
    schema: 'orbis.core-portable-staged.v1',
    sourceOwnerId: 1,
    ownerId: 17,
    pointId: f.point.id,
    restoreSupported: false,
    keyId: sha(f.master),
  });
  expect(result).not.toHaveProperty('pointKey');
  expect(result).not.toHaveProperty('authority');
  expect(result.payload).toMatchObject({
    schema: 'orbis.core-portable-payload.v1',
    pointId: f.point.id,
    manifestSha256: f.point.version === 3 ? f.point.core?.manifestSha256 : '',
  });
  for (const [name, item] of Object.entries(result.payload.files)) {
    const file = path.join(f.output, 'payload', name);
    expect(sha(await fs.readFile(file))).toBe(item.sha256);
    expect((await fs.stat(file)).mode & 0o7777).toBe(0o400);
  }
  const store = new TimeMachineStore(path.join(f.output, 'library'));
  const point = await store.load(f.point.id);
  if (point.version !== 3) throw new Error('Missing core point');
  expect(point.ownerId).toBe(17);
  expect(point.envelope.keyId).toBe(sha(f.master));
  expect(await store.readCoreDraft(point, new AbortController().signal)).toMatchObject({ id: f.point.id, version: 3 });
  expect((await store.metadata(point)).restore.ready).toBe(false);
  for (const name of ['core.orbis', 'metadata.orbis']) {
    expect(await fs.readFile(path.join(f.output, 'library/backups/time-machine/points', f.point.id, name))).toEqual(
      await fs.readFile(path.join(f.root, 'backups/time-machine/points', f.point.id, name)),
    );
  }
  expect(await fs.readFile(path.join(f.root, 'backups/time-machine/points', f.point.id, 'point.json'))).toEqual(originalPoint);
  await expect(stageCorePortableEnrollment({ input: f.input, output: f.output, signal: new AbortController().signal })).rejects.toThrow();
});
it.each(['owner', 'key', 'capsule', 'passphrase', 'unknown'] as const)('refuses invalid %s input before staged publication', async (attack) => {
  const f = await fixture();
  const request: Record<string, unknown> = { ...f.request };
  if (attack === 'owner') request.ownerId = 0;
  if (attack === 'key') request.keyId = 'a'.repeat(64);
  if (attack === 'capsule') request.capsuleSha256 = 'a'.repeat(64);
  if (attack === 'passphrase') request.passphrase = 'wrong archive passphrase';
  if (attack === 'unknown') request.sourceOwnerId = 99;
  await fs.chmod(path.join(f.input, 'request.json'), 0o600);
  await fs.writeFile(path.join(f.input, 'request.json'), JSON.stringify(request));
  await expect(stageCorePortableEnrollment({ input: f.input, output: f.output, signal: new AbortController().signal })).rejects.toThrow();
  await expect(fs.stat(path.join(f.output, 'library/backups/time-machine/points', f.point.id))).rejects.toThrow();
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CaptureFenceJournal } from './time-machine-capture-fence';
import { connectedCaptureFixture } from './time-machine-capture.fixture';
import { controllerPublicationSource } from './time-machine-capture-runtime';

let data: string;
let connected: Awaited<ReturnType<typeof connectedCaptureFixture>>;
let journal: CaptureFenceJournal;
beforeEach(async () => {
  data = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-private-fence-')));
  await fs.writeFile(path.join(data, '.env'), 'DISPOSABLE_FIXTURE=1\n');
  const config = {
    get: (key: string) =>
      ({ directories: { dataDir: data, appDataDir: path.join(data, 'app-data') }, architecture: 'arm64', envFilePath: path.join(data, '.env') })[key],
  };
  connected = await connectedCaptureFixture(data, config);
  journal = new CaptureFenceJournal(data);
});
afterEach(async () => {
  await fs.rm(data, { recursive: true, force: true });
});
async function prepared(id = randomUUID()) {
  const configuration = await connected.host.captureControllerConfiguration({
    pointId: id,
    controllerId: connected.ids.core,
    imageId: connected.image.id,
  });
  const expected = controllerPublicationSource(
    configuration,
    connected.image.id,
    await connected.engine.inspectControllerSource(connected.image.id),
    'arm64',
  );
  const receipt = await connected.host.prepareControllerPublication(expected);
  return { expected, receipt, id };
}
it('durably retains the exact private key and verified publication across a new journal instance', async () => {
  const { expected, receipt } = await prepared();
  const attempt = await journal.create(expected, receipt);
  const restarted = new CaptureFenceJournal(data);
  const [loaded] = await restarted.list();
  if (!loaded) throw new Error('Missing persisted attempt');
  expect(loaded.clientKey).toBe(attempt.clientKey);
  expect(loaded.expected).toEqual(expected);
  expect(loaded.receipt.read()).toEqual(receipt.read());
  expect(() => JSON.stringify(loaded)).toThrow();
  expect((await fs.stat(path.join(journal.directory, `${expected.configuration.pointId}.json`))).mode & 0o777).toBe(0o600);
  await restarted.remove(loaded);
  expect(await restarted.list()).toEqual([]);
});
it('does not replace the recovery key when two creations race for the same point', async () => {
  const { expected, receipt } = await prepared();
  const results = await Promise.allSettled([journal.create(expected, receipt), journal.create(expected, receipt)]);
  expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  const winner = results.find((value) => value.status === 'fulfilled');
  if (!winner || winner.status !== 'fulfilled') throw new Error('Missing journal winner');
  expect((await journal.list())[0]?.clientKey).toBe(winner.value.clientKey);
  expect(await fs.readdir(journal.directory)).toEqual([`${expected.configuration.pointId}.json`]);
});
it('recovers a crash between the exclusive canonical link and temporary-link removal', async () => {
  const { expected, receipt } = await prepared();
  const attempt = await journal.create(expected, receipt);
  const pending = path.join(journal.directory, `.${expected.configuration.pointId}.${'a'.repeat(32)}.pending`);
  await fs.link(path.join(journal.directory, `${expected.configuration.pointId}.json`), pending);
  expect((await new CaptureFenceJournal(data).list())[0]?.clientKey).toBe(attempt.clientKey);
  await expect(fs.lstat(pending)).rejects.toThrow();
});
it('removes only protected pre-acquire pending writes and preserves unknown files', async () => {
  await fs.mkdir(journal.directory, { recursive: true, mode: 0o700 });
  const pending = path.join(journal.directory, `.${randomUUID()}.${'a'.repeat(32)}.pending`);
  await fs.writeFile(pending, 'partial pre-acquire bytes', { mode: 0o600 });
  expect(await journal.list()).toEqual([]);
  await fs.writeFile(path.join(journal.directory, 'foreign.json'), '{}', { mode: 0o600 });
  await expect(journal.list()).rejects.toThrow();
  expect(await fs.readFile(path.join(journal.directory, 'foreign.json'), 'utf8')).toBe('{}');
});
it('rejects permission changes, symlink aliases and changed publication proof without discarding evidence', async () => {
  const { expected, receipt } = await prepared();
  await journal.create(expected, receipt);
  const file = path.join(journal.directory, `${expected.configuration.pointId}.json`);
  const bytes = await fs.readFile(file);
  await fs.chmod(file, 0o644);
  await expect(journal.list()).rejects.toThrow();
  await fs.chmod(file, 0o600);
  const other = path.join(data, 'private-other');
  await fs.rename(file, other);
  await fs.symlink(other, file);
  await expect(journal.list()).rejects.toThrow();
  await fs.unlink(file);
  await fs.rename(other, file);
  const value = JSON.parse(bytes.toString());
  value.receipt = Buffer.from('{}').toString('base64');
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await expect(journal.list()).rejects.toThrow();
  expect(await fs.readFile(file)).not.toEqual(bytes);
});

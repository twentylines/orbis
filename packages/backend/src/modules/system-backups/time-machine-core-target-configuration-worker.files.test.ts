import { createHash } from 'node:crypto';
import { constants, renameSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalCoreJson } from './time-machine-core-payload';
import { coreSourceConfigurationProfile } from './time-machine-core-source-configuration';
import { prepareCoreSourceConfiguration, prepareCoreTargetConfiguration } from './time-machine-core-source-configuration-worker';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const jwt = 'source-private-jwt-secret-'.repeat(2);
const source = `JWT_SECRET=${jwt}\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis\nADVANCED_SETTINGS=true\nALLOW_AUTO_THEMES=false\nQUEUE_TIMEOUT_IN_MINUTES=9\nLOG_LEVEL=debug\nMAX_BACKUPS=3\nTZ=UTC\nTHEME_BASE=gray\nTHEME_COLOR=blue\nAPPS_REPO_URL=https://source.invalid\n`;
const destination =
  'POSTGRES_HOST=db\nPOSTGRES_DBNAME=current\nPOSTGRES_USERNAME=target\nPOSTGRES_PASSWORD=secret\nRABBITMQ_HOST=queue\nRABBITMQ_USERNAME=queue\nRABBITMQ_PASSWORD=secret\nROOT_FOLDER_HOST=/srv/target\nRUNTIPI_APP_DATA_PATH=/srv/data\nARCHITECTURE=amd64\nTIPI_VERSION=4.10.1\nAPPS_REPO_URL=https://example.invalid/repo\nAPPS_REPO_ID=pinned-id\nTZ=Asia/Singapore\nINTERNAL_IP=192.0.2.10\nDOMAIN=target.example.invalid\nLOCAL_DOMAIN=target.lan\nDNS_IP=192.0.2.53\nNGINX_PORT=8080\nNGINX_PORT_SSL=8443\nPOSTGRES_PORT=5544\nRUNTIPI_FORWARD_AUTH_URL=http://target:3000/api/auth/traefik\nRUNTIPI_TRUSTED_PROXY_IPS=192.0.2.0/24\n';
const passkeys = Buffer.from('{"credentials":[{"id":"captured"}],"totp":"secret"}');
let directory: string;
let input: string;
let output: string;
const request = () => ({
  schema: 'orbis.core-target-configuration-worker-input.v1',
  id: 'ca29b935-6e49-4f65-b16a-69c0cf4ece5c',
  nonce: '1'.repeat(64),
  parserProfile: coreSourceConfigurationProfile,
  sourceWitnessSha256: '2'.repeat(64),
  sourceManifestSha256: '3'.repeat(64),
  controllerImageId: `sha256:${'4'.repeat(64)}`,
  configurationSha256: sha(source),
  passkeysSha256: sha(passkeys),
  destinationWitnessSha256: '5'.repeat(64),
  destinationConfigurationSha256: sha(destination),
  targetDatabaseName: 'restored_1',
});
const options = () => ({ input, output, signal: new AbortController().signal });
const writeRequest = (value: object = request()) => fs.writeFile(path.join(input, 'request.json'), canonicalCoreJson(value), { mode: 0o600 });
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-target-worker-')));
  input = path.join(directory, 'input');
  output = path.join(directory, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  await writeRequest();
  for (const [name, data] of [
    ['configuration.env', source],
    ['destination.env', destination],
    ['passkeys.json', passkeys],
  ] as const)
    await fs.writeFile(path.join(input, name), data, { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('produces sealed private outputs bound to the source and destination', async () => {
  const report = await prepareCoreTargetConfiguration(options());
  const envBytes = await fs.readFile(path.join(output, 'target.env'));
  const settingsBytes = await fs.readFile(path.join(output, 'target-settings.json'));
  const auth = await fs.readFile(path.join(output, 'source-authentication.json'));
  const env = parse(envBytes);
  const settings = JSON.parse(settingsBytes.toString());
  expect(JSON.parse(auth.toString())).toEqual({ jwtSecret: jwt, passkeys: JSON.parse(passkeys.toString()) });
  expect(env).toMatchObject({
    JWT_SECRET: jwt,
    POSTGRES_DBNAME: 'restored_1',
    APPS_REPO_URL: 'https://example.invalid/repo',
    APPS_REPO_ID: 'pinned-id',
    POSTGRES_HOST: 'db',
    TZ: 'UTC',
  });
  expect(settings).toMatchObject({
    advancedSettings: true,
    allowAutoThemes: false,
    eventsTimeout: 9,
    logLevel: 'debug',
    maxBackups: 3,
    timeZone: 'UTC',
    themeBase: 'gray',
    themeColor: 'blue',
  });
  expect(report.target).toEqual({
    schema: 'orbis.core-target-configuration.v1',
    destinationWitnessSha256: request().destinationWitnessSha256,
    destinationConfigurationSha256: sha(destination),
    databaseName: 'restored_1',
    configurationSha256: sha(envBytes),
    settingsSha256: sha(settingsBytes),
    sourceAuthenticationSha256: sha(auth),
    sessionPolicy: 'new-empty-cache-required',
    environmentProved: false,
    restoreAuthority: false,
    activation: false,
  });
  expect(await fs.readFile(path.join(output, 'result.json'), 'utf8')).toBe(canonicalCoreJson(report));
  expect((await fs.readdir(output)).sort()).toEqual(['result.json', 'source-authentication.json', 'target-settings.json', 'target.env']);
  for (const name of await fs.readdir(output)) expect((await fs.stat(path.join(output, name))).mode & 0o777).toBe(0o400);
  expect(await fs.readFile(path.join(input, 'configuration.env'), 'utf8')).toBe(source);
});

it('uses destination values when source portable fields are absent', async () => {
  const minimal = `JWT_SECRET=${jwt}\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis\n`;
  await fs.writeFile(path.join(input, 'configuration.env'), minimal);
  await writeRequest({ ...request(), configurationSha256: sha(minimal) });
  await prepareCoreTargetConfiguration(options());
  expect(parse(await fs.readFile(path.join(output, 'target.env'))).TZ).toBe('Asia/Singapore');
});

it.each(['nonce', 'schema', 'configurationSha256', 'destinationConfigurationSha256', 'targetDatabaseName', 'destinationWitnessSha256'])(
  'rejects invalid %s',
  async (field) => {
    await writeRequest({ ...request(), [field]: field === 'targetDatabaseName' ? 'postgres' : 'invalid' });
    await expect(prepareCoreTargetConfiguration(options())).rejects.toThrow('Captured source configuration preparation failed.');
    expect(await fs.readdir(output)).toEqual([]);
  },
);

it.each(['ADVANCED_SETTINGS=maybe', 'MAX_BACKUPS=-1', 'QUEUE_TIMEOUT_IN_MINUTES=1.2'])(
  'rejects malformed portable setting %s privately',
  async (line) => {
    const value = `${source}\n${line}\n`;
    await fs.writeFile(path.join(input, 'configuration.env'), value);
    await writeRequest({ ...request(), configurationSha256: sha(value) });
    await expect(prepareCoreTargetConfiguration(options())).rejects.toThrow('Captured source configuration preparation failed.');
    expect(await fs.readdir(output)).toEqual([]);
  },
);

it.each(['extra', 'symlink', 'hardlink', 'shared', 'output'])('rejects unsafe boundary: %s', async (kind) => {
  const file = path.join(input, 'destination.env');
  if (kind === 'extra') await fs.writeFile(path.join(input, 'extra'), 'x');
  if (kind === 'shared') await fs.chmod(input, 0o755);
  if (kind === 'output') await fs.writeFile(path.join(output, 'existing'), 'preserve');
  if (kind === 'symlink' || kind === 'hardlink') {
    const moved = path.join(directory, 'moved');
    await fs.rename(file, moved);
    if (kind === 'symlink') await fs.symlink(moved, file);
    else await fs.link(moved, file);
  }
  await expect(prepareCoreTargetConfiguration(options())).rejects.toThrow();
  if (kind === 'output') expect(await fs.readFile(path.join(output, 'existing'), 'utf8')).toBe('preserve');
});

it('rejects cancellation and hides secret parser errors', async () => {
  const controller = new AbortController();
  controller.abort(new Error(jwt));
  await expect(prepareCoreTargetConfiguration({ ...options(), signal: controller.signal })).rejects.toThrow(
    'Captured source configuration preparation failed.',
  );
  await fs.writeFile(path.join(input, 'destination.env'), `${destination}\nBAD=${jwt}\0`);
  try {
    await prepareCoreTargetConfiguration(options());
    throw new Error('expected rejection');
  } catch (error) {
    expect(String(error)).not.toContain(jwt);
    expect((error as Error).cause).toBeUndefined();
  }
  expect(await fs.readdir(output)).toEqual([]);
});

it.each(['input', 'output'] as const)('detects a replaced %s after pinning', async (kind) => {
  let calls = 0;
  const signal = {
    throwIfAborted() {
      calls++;
      if ((kind === 'input' && calls === 2) || (kind === 'output' && calls === 7)) {
        const file = path.join(kind === 'input' ? input : output, kind === 'input' ? 'destination.env' : 'target.env');
        renameSync(file, `${file}.replaced`);
        writeFileSync(file, 'replacement', { mode: 0o600 });
      }
    },
  } as AbortSignal;
  await expect(prepareCoreTargetConfiguration({ ...options(), signal })).rejects.toThrow('Captured source configuration preparation failed.');
});

async function prepare(mode: 'source' | 'target') {
  if (mode === 'target') return prepareCoreTargetConfiguration(options());
  const { destinationWitnessSha256: _witness, destinationConfigurationSha256: _configuration, targetDatabaseName: _database, ...value } = request();
  await writeRequest({ ...value, schema: 'orbis.core-source-configuration-worker-input.v1' });
  await fs.rm(path.join(input, 'destination.env'));
  return prepareCoreSourceConfiguration(options());
}

function afterWriterClose(action: (file: string) => Promise<void>) {
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args);
    if (args[0] === path.join(output, 'source-authentication.json') && typeof args[1] === 'number' && args[1] & constants.O_WRONLY) {
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await action(String(args[0]));
      };
    }
    return handle;
  });
}

it.each(['source', 'target'] as const)('%s verifies bytes and seals after the creator finishes closing', async (mode) => {
  let finalizations = 0;
  afterWriterClose(async (file) => {
    finalizations++;
    await fs.utimes(file, new Date(), new Date(Date.now() + 5000));
  });
  const report = await prepare(mode);
  const auth = await fs.readFile(path.join(output, 'source-authentication.json'));
  expect(report.projection.sourceAuthenticationSha256).toBe(sha(auth));
  expect(finalizations).toBe(1);
});

it.each(['source', 'target'] as const)('%s rejects changed bytes during creator close even at the same size', async (mode) => {
  afterWriterClose(async (file) => {
    const bytes = await fs.readFile(file);
    bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
    await fs.chmod(file, 0o600);
    await fs.writeFile(file, bytes);
    await fs.chmod(file, 0o400);
  });
  await expect(prepare(mode)).rejects.toThrow('Captured source configuration preparation failed.');
  expect(await fs.readdir(output)).not.toContain('result.json');
});

it.each(['source', 'target'] as const)('%s rejects a same-byte replacement inode during creator close', async (mode) => {
  afterWriterClose(async (file) => {
    const replacement = path.join(directory, 'replacement');
    await fs.writeFile(replacement, await fs.readFile(file), { mode: 0o400 });
    await fs.rename(replacement, file);
  });
  await expect(prepare(mode)).rejects.toThrow('Captured source configuration preparation failed.');
  expect(await fs.readdir(output)).not.toContain('result.json');
});

it.each(['source', 'target'] as const)('%s retains final metadata checks after publication', async (mode) => {
  const original = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (
      args[0] === path.join(output, mode === 'source' ? 'result.json' : 'target.env') &&
      typeof args[1] === 'number' &&
      args[1] & constants.O_WRONLY
    )
      await fs.utimes(path.join(output, 'source-authentication.json'), new Date(), new Date(Date.now() + 5000));
    return original(...args);
  });
  await expect(prepare(mode)).rejects.toThrow('Captured source configuration preparation failed.');
});

it.each(['source', 'target'] as const)('%s rejects close failure without retry or secret disclosure', async (mode) => {
  let closes = 0;
  afterWriterClose(async () => {
    closes++;
    throw new Error(jwt);
  });
  try {
    await prepare(mode);
    throw new Error('expected close rejection');
  } catch (error) {
    expect(String(error)).toBe('Error: Captured source configuration preparation failed.');
    expect((error as Error).cause).toBeUndefined();
  }
  expect(closes).toBe(1);
  expect(await fs.readdir(output)).not.toContain('result.json');
});

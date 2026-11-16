import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalCoreJson } from './time-machine-core-payload';
import { coreSourceConfigurationProfile } from './time-machine-core-source-configuration';
import {
  coreSourceConfigurationWorkerCapability,
  prepareCoreSourceConfiguration,
  prepareCoreLiveAuthentication,
} from './time-machine-core-source-configuration-worker';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const key = 'private source preparation fixture '.repeat(2).trimEnd();
const configuration = `JWT_SECRET="${key}"\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis\n`;
let directory: string;
let input: string;
let output: string;
const request = () => ({
  schema: 'orbis.core-source-configuration-worker-input.v1',
  id: 'ca29b935-6e49-4f65-b16a-69c0cf4ece5c',
  nonce: '1'.repeat(64),
  parserProfile: coreSourceConfigurationProfile,
  sourceWitnessSha256: '2'.repeat(64),
  sourceManifestSha256: '3'.repeat(64),
  controllerImageId: `sha256:${'4'.repeat(64)}`,
  configurationSha256: sha(configuration),
  passkeysSha256: null as string | null,
});
const options = () => ({ input, output, signal: new AbortController().signal });
async function writeRequest(value: object = request()) {
  await fs.writeFile(path.join(input, 'request.json'), canonicalCoreJson(value), { mode: 0o600 });
}

beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'core-source-configuration-')));
  input = path.join(directory, 'input');
  output = path.join(directory, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  await writeRequest();
  await fs.writeFile(path.join(input, 'configuration.env'), configuration, { mode: 0o600 });
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

async function liveSetup() {
  const controller = [
    'JWT_SECRET=stale synthetic key which is long enough',
    'POSTGRES_HOST=runtipi-db',
    'POSTGRES_USERNAME=tipi',
    'POSTGRES_DBNAME=orbis',
    'POSTGRES_PASSWORD=synthetic current password',
  ];
  const database = ['POSTGRES_USER=tipi', 'POSTGRES_DB=orbis', 'POSTGRES_PASSWORD=synthetic current password'];
  const value = {
    schema: 'orbis.core-live-authentication-input.v1',
    id: request().id,
    nonce: request().nonce,
    parserProfile: coreSourceConfigurationProfile,
    liveSnapshotSha256: '2'.repeat(64),
    publicationSha256: '3'.repeat(64),
    controllerId: '4'.repeat(64),
    controllerImageId: `sha256:${'5'.repeat(64)}`,
    configurationSha256: sha(configuration),
    controllerEnvironmentSha256: sha(canonicalCoreJson(controller)),
    databaseEnvironmentSha256: sha(canonicalCoreJson(database)),
    passkeysSha256: null as string | null,
  };
  await fs.writeFile(path.join(input, 'controller-environment.json'), canonicalCoreJson(controller), { mode: 0o600 });
  await fs.writeFile(path.join(input, 'database-environment.json'), canonicalCoreJson(database), { mode: 0o600 });
  await writeRequest(value);
  return value;
}

describe('current Root authentication projection', () => {
  it('writes bound authentication and database candidates with file override and private exact outputs', async () => {
    const request = await liveSetup();
    const report = await prepareCoreLiveAuthentication(options());
    const authentication = await fs.readFile(path.join(output, 'authentication.json'));
    const database = await fs.readFile(path.join(output, 'database.json'));
    expect(JSON.parse(authentication.toString())).toEqual({ jwtSecret: key, passkeys: null });
    expect(JSON.parse(database.toString())).toEqual({
      host: 'runtipi-db',
      port: 5432,
      user: 'tipi',
      password: 'synthetic current password',
      database: 'orbis',
    });
    expect(report).toMatchObject({
      schema: 'orbis.core-live-authentication-result.v1',
      id: request.id,
      projection: {
        liveSnapshotSha256: request.liveSnapshotSha256,
        authenticationSha256: sha(authentication),
        databaseSha256: sha(database),
        basis: 'current-controller-configuration-candidate',
        environmentProved: false,
        restoreAuthority: false,
        activation: false,
      },
    });
    expect(JSON.stringify(report)).not.toContain(key);
    expect(JSON.stringify(report)).not.toContain('synthetic current password');
    expect((await fs.readdir(output)).sort()).toEqual(['authentication.json', 'database.json', 'result.json']);
    for (const name of await fs.readdir(output)) expect((await fs.lstat(path.join(output, name))).mode & 0o777).toBe(0o400);
  });
  it('supports an empty current file instead of imposing captured-only requirements', async () => {
    const value = await liveSetup();
    await fs.writeFile(path.join(input, 'configuration.env'), '');
    await writeRequest({ ...value, configurationSha256: sha('') });
    await expect(prepareCoreLiveAuthentication(options())).resolves.toMatchObject({ restoreAuthority: false });
  });
  it.each([
    'liveSnapshotSha256',
    'publicationSha256',
    'controllerId',
    'controllerImageId',
    'controllerEnvironmentSha256',
    'databaseEnvironmentSha256',
    'configurationSha256',
    'passkeysSha256',
    'parserProfile',
    'schema',
    'id',
    'nonce',
  ])('refuses changed or invalid %s before output', async (field) => {
    const value = await liveSetup();
    await writeRequest({ ...value, [field]: 'invalid' });
    await expect(prepareCoreLiveAuthentication(options())).rejects.toThrow();
    expect(await fs.readdir(output)).toEqual([]);
  });
  it('keeps unknown residue and links outside the private projection', async () => {
    await liveSetup();
    await fs.writeFile(path.join(input, 'extra'), 'foreign');
    await expect(prepareCoreLiveAuthentication(options())).rejects.toThrow();
    expect(await fs.readdir(output)).toEqual([]);
    await fs.unlink(path.join(input, 'extra'));
    await fs.rename(path.join(input, 'controller-environment.json'), path.join(directory, 'foreign.json'));
    await fs.symlink(path.join(directory, 'foreign.json'), path.join(input, 'controller-environment.json'));
    await expect(prepareCoreLiveAuthentication(options())).rejects.toThrow();
    expect(await fs.readdir(output)).toEqual([]);
  });
});

describe('Root-bound configuration projection worker files', () => {
  it('writes only private bound outputs and never claims environment or restore authority', async () => {
    const manifest = await fs.readFile(path.join(input, 'request.json'));
    const before = await fs.readFile(path.join(input, 'configuration.env'));
    const report = await prepareCoreSourceConfiguration(options());
    const authentication = await fs.readFile(path.join(output, 'source-authentication.json'));
    expect(JSON.parse(authentication.toString())).toEqual({ jwtSecret: key, passkeys: null });
    expect(report).toMatchObject({
      schema: 'orbis.core-source-configuration-worker-result.v1',
      id: request().id,
      nonce: request().nonce,
      inputSha256: sha(manifest),
      restoreAuthority: false,
      projection: {
        sourceWitnessSha256: request().sourceWitnessSha256,
        configurationSha256: sha(configuration),
        sourceAuthenticationSha256: sha(authentication),
        role: 'tipi',
        database: 'orbis',
        environmentBasis: 'captured-complete-configuration',
        environmentProved: false,
        restoreAuthority: false,
      },
    });
    const result = await fs.readFile(path.join(output, 'result.json'));
    expect(result.toString()).toBe(canonicalCoreJson(report));
    expect(result.toString()).not.toContain(key);
    expect((await fs.stat(path.join(output, 'result.json'))).mode & 0o777).toBe(0o400);
    expect((await fs.stat(path.join(output, 'source-authentication.json'))).mode & 0o777).toBe(0o400);
    expect(await fs.readFile(path.join(input, 'configuration.env'))).toEqual(before);
    expect((await fs.readdir(output)).sort()).toEqual(['result.json', 'source-authentication.json']);
    expect(coreSourceConfigurationWorkerCapability.restoreAuthority).toBe(false);
  });

  it('preserves bound passkey data as private authentication input', async () => {
    const passkeys = Buffer.from('{"credentials":[]}');
    await fs.writeFile(path.join(input, 'passkeys.json'), passkeys, { mode: 0o600 });
    await writeRequest({ ...request(), passkeysSha256: sha(passkeys) });
    const report = await prepareCoreSourceConfiguration(options());
    expect(report.projection.passkeysSha256).toBe(sha(passkeys));
    expect(JSON.parse(await fs.readFile(path.join(output, 'source-authentication.json'), 'utf8')).passkeys).toEqual({ credentials: [] });
  });

  it.each(['configurationSha256', 'passkeysSha256'] as const)('rejects changed %s without producing outputs', async (field) => {
    if (field === 'passkeysSha256') await fs.writeFile(path.join(input, 'passkeys.json'), '{}', { mode: 0o600 });
    await writeRequest({ ...request(), [field]: 'f'.repeat(64) });
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow('Captured source configuration preparation failed.');
    expect(await fs.readdir(output)).toEqual([]);
  });

  it.each(['schema', 'id', 'nonce', 'parserProfile', 'controllerImageId', 'sourceWitnessSha256', 'sourceManifestSha256'])(
    'rejects a malformed %s',
    async (field) => {
      await writeRequest({ ...request(), [field]: 'unsupported' });
      await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
      expect(await fs.readdir(output)).toEqual([]);
    },
  );

  it('requires canonical exact input and refuses duplicate, extra or private authority claims', async () => {
    for (const body of [
      JSON.stringify(request(), null, 2),
      `${canonicalCoreJson(request()).slice(0, -1)},"nonce":"${request().nonce}"}`,
      canonicalCoreJson({ ...request(), restoreAuthority: true }),
      canonicalCoreJson({ ...request(), controllerEnvironment: ['JWT_SECRET=destination-value'] }),
    ]) {
      await fs.writeFile(path.join(input, 'request.json'), body);
      await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
      expect(await fs.readdir(output)).toEqual([]);
    }
  });

  it('does not turn missing, unexpected or unreadable passkey files into absence', async () => {
    await writeRequest({ ...request(), passkeysSha256: 'a'.repeat(64) });
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    await writeRequest();
    await fs.writeFile(path.join(input, 'passkeys.json'), '{}', { mode: 0o600 });
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    expect(await fs.readdir(output)).toEqual([]);
  });

  it.each(['symlink', 'hardlink', 'directory', 'shared'] as const)('rejects a %s configuration leaf', async (kind) => {
    const file = path.join(input, 'configuration.env');
    const outside = path.join(directory, 'source.env');
    if (kind === 'shared') await fs.chmod(file, 0o644);
    else {
      await fs.rename(file, outside);
      if (kind === 'symlink') await fs.symlink(outside, file);
      if (kind === 'hardlink') await fs.link(outside, file);
      if (kind === 'directory') await fs.mkdir(file, { mode: 0o700 });
    }
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    expect(await fs.readdir(output)).toEqual([]);
  });

  it('requires distinct private canonical directories and an empty output', async () => {
    await expect(prepareCoreSourceConfiguration({ ...options(), output: input })).rejects.toThrow();
    const child = path.join(input, 'child');
    await fs.mkdir(child, { mode: 0o700 });
    await expect(prepareCoreSourceConfiguration({ ...options(), output: child })).rejects.toThrow();
    await fs.rm(child, { recursive: true });
    const alias = path.join(directory, 'alias');
    await fs.symlink(input, alias);
    await expect(prepareCoreSourceConfiguration({ ...options(), input: alias })).rejects.toThrow();
    await fs.chmod(output, 0o755);
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    await fs.chmod(output, 0o700);
    await fs.writeFile(path.join(output, 'existing'), 'preserve', { mode: 0o600 });
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    expect(await fs.readFile(path.join(output, 'existing'), 'utf8')).toBe('preserve');
  });

  it('does not overwrite or replay an existing completed output', async () => {
    await prepareCoreSourceConfiguration(options());
    const before = await fs.readFile(path.join(output, 'result.json'));
    await expect(prepareCoreSourceConfiguration(options())).rejects.toThrow();
    expect(await fs.readFile(path.join(output, 'result.json'))).toEqual(before);
  });

  it('aborts without publishing outputs and hides secret-bearing parser failures', async () => {
    const controller = new AbortController();
    controller.abort(new Error(key));
    await expect(prepareCoreSourceConfiguration({ ...options(), signal: controller.signal })).rejects.toThrow(
      'Captured source configuration preparation failed.',
    );
    const secret = `DOTENV_KEY=${key}\n${configuration}`;
    await fs.writeFile(path.join(input, 'configuration.env'), secret);
    await writeRequest({ ...request(), configurationSha256: sha(secret) });
    try {
      await prepareCoreSourceConfiguration(options());
      throw new Error('Expected preparation rejection');
    } catch (failure) {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Captured source configuration preparation failed.');
      expect((failure as Error).cause).toBeUndefined();
      expect(String(failure)).not.toContain(key);
    }
    expect(await fs.readdir(output)).toEqual([]);
  });
});

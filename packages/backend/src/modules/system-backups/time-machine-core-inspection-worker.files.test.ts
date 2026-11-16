import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  coreSourceCatalogBootstrapEvidence,
  inspectCoreDatabase,
  inspectCoreDatabaseStructure,
  requireCoreSourceOwner,
} from './time-machine-core-database';
import {
  bootstrapSourceCoreInspectionWorkerCapability,
  coreVersionedInspectionSettings,
  coreInspectionFailureDiagnostic,
  coreInspectionSettings,
  coreInspectionWorkerCapability,
  inspectCoreSource,
  roleBoundCoreInspectionSettings,
  roleBoundCoreInspectionWorkerCapability,
  verifyCoreInspectionSettings,
  versionedBootstrapSourceCoreInspectionWorkerCapability,
} from './time-machine-core-inspection-worker';
import { corePgExecutionProfile } from './time-machine-core-pg-profile';
import { canonicalCoreJson } from './time-machine-core-payload';
import { coreSourceConfigurationProfile, projectCoreSourceConfiguration } from './time-machine-core-source-configuration';

const state = vi.hoisted(() => ({
  queries: [] as string[],
  connected: 0,
  config: {} as Record<string, unknown>,
  settings: {} as Record<string, string>,
  connectFailure: undefined as unknown,
  queryFailure: undefined as unknown,
  queryFailureAt: 0,
  queryHook: undefined as ((count: number) => Promise<void>) | undefined,
  identity: { current_user: 'postgres', session_user: 'postgres' } as Record<string, unknown>,
  serverVersion: '170006',
  locale: { encoding: 'UTF8', collate: 'C', ctype: 'C', provider: 'c' } as Record<string, unknown>,
}));
vi.mock('pg', () => ({
  Client: class {
    constructor(config: Record<string, unknown>) {
      state.config = config;
    }
    on() {}
    async connect() {
      state.connected += 1;
      if (state.connectFailure !== undefined) throw state.connectFailure;
    }
    async query(sql: string) {
      state.queries.push(sql);
      if (state.queries.length === state.queryFailureAt) throw state.queryFailure;
      await state.queryHook?.(state.queries.length);
      if (sql === 'SHOW server_version_num') return { rows: [{ server_version_num: state.serverVersion }] };
      if (sql.includes('FROM pg_catalog.pg_database d WHERE')) {
        const row: Record<string, unknown> = { database: state.config.database, ...state.locale };
        if (!sql.includes('datlocprovider')) delete row.provider;
        return { rows: [row] };
      }
      if (sql === 'SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user') return { rows: [{ ...state.identity }] };
      const name = sql.replace('SHOW ', '');
      return { rows: [{ [name]: state.settings[name] }] };
    }
    async end() {}
  },
}));
vi.mock('./time-machine-core-database', () => ({
  inspectCoreDatabase: vi.fn(),
  inspectCoreDatabaseStructure: vi.fn(),
  requireCoreSourceOwner: vi.fn(),
  coreSourceCatalogBootstrapEvidence: vi.fn(),
}));
const roots: string[] = [];
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.restoreAllMocks();
  state.queries = [];
  state.connected = 0;
  state.config = {};
  state.settings = {};
  state.connectFailure = undefined;
  state.queryFailure = undefined;
  state.queryFailureAt = 0;
  state.queryHook = undefined;
  state.identity = { current_user: 'postgres', session_user: 'postgres' };
  state.serverVersion = '170006';
  state.locale = { encoding: 'UTF8', collate: 'C', ctype: 'C', provider: 'c' };
});
async function fixture(authentication = true) {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '', 'core-inspection-worker-'));
  roots.push(root);
  const input = path.join(root, 'input');
  const output = path.join(root, 'output');
  await fs.mkdir(input, { mode: 0o700 });
  await fs.mkdir(output, { mode: 0o700 });
  const auth = Buffer.from(JSON.stringify({ jwtSecret: 'synthetic-source-jwt-key-for-inspection', passkeys: null }));
  const request = {
    schema: 'orbis.core-inspection-worker-input.v1',
    id: randomUUID(),
    nonce: '1'.repeat(64),
    permitSha256: '2'.repeat(64),
    resourcesSha256: '3'.repeat(64),
    sourceManifestSha256: '4'.repeat(64),
    database: 'orbis_core_fixture_source',
    sourceOwnerId: 11,
    sourceImageId: coreInspectionWorkerCapability.sourceImage,
    sourceAuthenticationSha256: authentication ? sha(auth) : null,
    settingsSha256: coreInspectionWorkerCapability.settingsSha256,
  };
  await fs.writeFile(path.join(input, 'request.json'), canonicalCoreJson(request), { mode: 0o400 });
  if (authentication) await fs.writeFile(path.join(input, 'source-authentication.json'), auth, { mode: 0o400 });
  state.settings = { ...coreInspectionSettings, archive_command: '(disabled)' };
  const structure = {
    schema: 'orbis.core-database-structure.v1' as const,
    sha256: '5'.repeat(64),
    major: 17,
    catalogSha256: '6'.repeat(64),
    rows: { user: 1, link: 1, app: 1, app_store: 1, orbis_reset_receipt: 0, __drizzle_migrations: 1 },
    authenticationVerified: false as const,
    restoreAuthority: false as const,
  };
  vi.mocked(inspectCoreDatabaseStructure).mockResolvedValue(structure);
  vi.mocked(inspectCoreDatabase).mockResolvedValue({
    token: {} as never,
    summary: {
      schema: 'orbis.core-database-snapshot.v1',
      sha256: structure.sha256,
      major: 17,
      catalogSha256: structure.catalogSha256,
      rows: structure.rows,
    },
  });
  vi.mocked(requireCoreSourceOwner).mockResolvedValue({
    schema: 'orbis.core-source-owner.v1',
    sourceOwnerId: 11,
    sourceSha256: structure.sha256,
    identitySha256: '7'.repeat(64),
    authenticationSha256: '8'.repeat(64),
    restoreAuthority: false,
  });
  return { input, output, request, auth, structure, signal: new AbortController().signal };
}
async function roleFixture() {
  const f = await fixture();
  const request: Record<string, unknown> = {
    ...f.request,
    schema: 'orbis.core-inspection-worker-input.v2',
    settingsSha256: roleBoundCoreInspectionWorkerCapability.settingsSha256,
    role: 'captured_app_role',
    sourceProjectionSha256: 'a'.repeat(64),
  };
  state.settings = { ...roleBoundCoreInspectionSettings, archive_command: '(disabled)' };
  state.identity = { current_user: request.role, session_user: request.role };
  await fs.chmod(path.join(f.input, 'request.json'), 0o600);
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(request));
  return { ...f, request };
}

it('uses the bound application role and checks its session identity before and after inspection', async () => {
  const f = await roleFixture();
  const report = await inspectCoreSource(f);
  expect(state.config).toMatchObject({
    user: 'captured_app_role',
    password: '',
    options: '-c search_path=pg_catalog -c default_transaction_read_only=on -c session_preload_libraries= -c local_preload_libraries=',
  });
  expect(report).toMatchObject({
    schema: 'orbis.core-inspection-worker-result.v2',
    role: f.request.role,
    sourceProjectionSha256: f.request.sourceProjectionSha256,
    settingsSha256: roleBoundCoreInspectionWorkerCapability.settingsSha256,
    compatibilityRefusal: 'source-effective-environment-unproved',
    restoreAuthority: false,
  });
  expect(state.queries.filter((sql) => sql === 'SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user')).toHaveLength(2);
  expect(state.queries).toHaveLength((Object.keys(roleBoundCoreInspectionSettings).length + 1) * 2);
  expect(JSON.parse(await fs.readFile(path.join(f.output, 'result.json'), 'utf8'))).toEqual(report);
  expect(coreSourceCatalogBootstrapEvidence).not.toHaveBeenCalled();
  expect(report).not.toHaveProperty('bootstrapSource');
  expect(report).not.toHaveProperty('evidenceScope');
});

async function bootstrapFixture() {
  const f = await roleFixture();
  f.request.schema = 'orbis.core-inspection-worker-input.v3';
  f.request.evidenceScope = 'authenticated-bootstrap-source';
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(f.request));
  const owner = await vi.mocked(requireCoreSourceOwner).getMockImplementation()?.({} as never, 11);
  if (!owner) throw new Error('fixture source owner missing');
  const evidence = {
    schema: 'orbis.core-source-bootstrap-evidence.v2' as const,
    sourceSha256: f.structure.sha256,
    catalogSha256: f.structure.catalogSha256,
    authenticationSha256: owner.authenticationSha256,
    sourceOwnerId: owner.sourceOwnerId,
    identitySha256: owner.identitySha256,
    catalogUserIdentities: [{ ownerId: owner.sourceOwnerId, identitySha256: owner.identitySha256 }],
    database: f.request.database as string,
    systemIdentifier: '7000000000000000001',
    migrationLedger: [{ id: 3, hash: 'b'.repeat(64), created_at: '1700000000000' }],
    authenticationVerified: true as const,
    environmentProved: false as const,
    restoreAuthority: false as const,
  };
  vi.mocked(coreSourceCatalogBootstrapEvidence).mockResolvedValue(evidence);
  return { ...f, evidence };
}

it('exports authenticated v3 bootstrap evidence using the same captured token, source owner and unchanged v2 role profile', async () => {
  const f = await bootstrapFixture();
  const report = await inspectCoreSource(f);
  expect(bootstrapSourceCoreInspectionWorkerCapability).toEqual({
    ...roleBoundCoreInspectionWorkerCapability,
    protocol: 3,
    evidenceScope: 'authenticated-bootstrap-source',
  });
  expect(report).toMatchObject({
    schema: 'orbis.core-inspection-worker-result.v3',
    evidenceScope: 'authenticated-bootstrap-source',
    bootstrapSource: f.evidence,
    role: f.request.role,
    sourceProjectionSha256: f.request.sourceProjectionSha256,
    compatibilityRefusal: 'source-effective-environment-unproved',
    restoreAuthority: false,
  });
  const inspected = await vi.mocked(inspectCoreDatabase).mock.results[0]?.value;
  expect(coreSourceCatalogBootstrapEvidence).toHaveBeenCalledExactlyOnceWith(inspected.token, f.request.sourceOwnerId);
  expect(requireCoreSourceOwner).toHaveBeenCalledExactlyOnceWith(inspected.token, f.request.sourceOwnerId);
  expect(state.queries).toHaveLength((Object.keys(roleBoundCoreInspectionSettings).length + 1) * 2);
  const bytes = await fs.readFile(path.join(f.output, 'result.json'), 'utf8');
  expect(JSON.parse(bytes)).toEqual(report);
  expect(bytes).not.toContain('synthetic-source-jwt-key-for-inspection');
});

it.each(['missing-scope', 'wrong-scope', 'missing-auth', 'extra-field', 'v2-with-scope'])(
  'refuses v3 bootstrap source %s before connecting',
  async (attack) => {
    const f = await bootstrapFixture();
    if (attack === 'missing-scope') delete f.request.evidenceScope;
    if (attack === 'wrong-scope') f.request.evidenceScope = 'restore';
    if (attack === 'missing-auth') f.request.sourceAuthenticationSha256 = null;
    if (attack === 'extra-field') f.request.bootstrapSource = f.evidence;
    if (attack === 'v2-with-scope') f.request.schema = 'orbis.core-inspection-worker-input.v2';
    await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(f.request));
    await expect(inspectCoreSource(f)).rejects.toThrow();
    expect(state.connected).toBe(0);
    expect(coreSourceCatalogBootstrapEvidence).not.toHaveBeenCalled();
    expect(await fs.readdir(f.output)).toEqual([]);
  },
);

it.each(['authentication', 'ownership', 'bootstrap-export'])(
  'refuses v3 %s failures without writing evidence or exposing secret-bearing errors',
  async (stage) => {
    const f = await bootstrapFixture();
    const error = new Error('private SELECT secret FROM user jwtSecret password');
    if (stage === 'authentication') vi.mocked(inspectCoreDatabase).mockRejectedValueOnce(error);
    if (stage === 'ownership') vi.mocked(requireCoreSourceOwner).mockRejectedValueOnce(error);
    if (stage === 'bootstrap-export') vi.mocked(coreSourceCatalogBootstrapEvidence).mockRejectedValueOnce(error);
    const failure = await inspectCoreSource(f).catch((caught: unknown) => caught);
    expect((failure as Error).message).toBe('Core source inspection failed.');
    expect((failure as Error).cause).toBeUndefined();
    expect(coreInspectionFailureDiagnostic(failure)).toEqual({ event: 'core-inspection-failed', phase: 'source-auth', code: 'unknown' });
    expect(await fs.readdir(f.output)).toEqual([]);
  },
);

it('inspects projected captured-configuration candidates without granting them restore authority', async () => {
  const f = await roleFixture();
  const configuration = Buffer.from('JWT_SECRET="captured fixture key with quotes and equals=kept"\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis');
  const projected = projectCoreSourceConfiguration({
    parserProfile: coreSourceConfigurationProfile,
    sourceWitnessSha256: 'b'.repeat(64),
    sourceManifestSha256: f.request.sourceManifestSha256 as string,
    controllerImageId: `sha256:${'c'.repeat(64)}`,
    controllerEnvironment: null,
    databaseEnvironment: null,
    configuration: { bytes: configuration, sha256: sha(configuration) },
    passkeys: null,
  });
  const request = {
    ...f.request,
    role: projected.projection.role,
    database: projected.projection.database,
    sourceProjectionSha256: sha(canonicalCoreJson(projected.projection)),
    sourceAuthenticationSha256: projected.projection.sourceAuthenticationSha256,
  };
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(request));
  await fs.chmod(path.join(f.input, 'source-authentication.json'), 0o600);
  await fs.writeFile(path.join(f.input, 'source-authentication.json'), projected.sourceAuthenticationBytes);
  state.identity = { current_user: request.role, session_user: request.role };
  const report = await inspectCoreSource(f);
  expect(state.config).toMatchObject({ user: 'tipi', database: 'orbis', password: '' });
  expect(vi.mocked(inspectCoreDatabase).mock.calls[0]?.[0].authentication).toEqual({
    jwtSecret: 'captured fixture key with quotes and equals=kept',
  });
  expect(report).toMatchObject({
    role: 'tipi',
    sourceProjectionSha256: request.sourceProjectionSha256,
    sourceAuthenticationSha256: request.sourceAuthenticationSha256,
    compatibilityRefusal: 'source-effective-environment-unproved',
    restoreAuthority: false,
  });
  expect(JSON.stringify(report)).not.toContain('captured fixture key');
});

it.each(['blank-role', 'injected-role', 'long-role', 'projection', 'settings', 'missing-projection', 'missing-auth', 'v1-with-role'])(
  'rejects invalid role-bound %s before connecting',
  async (attack) => {
    const f = await roleFixture();
    if (attack === 'blank-role') f.request.role = '';
    if (attack === 'injected-role') f.request.role = 'role\nlocal all all trust';
    if (attack === 'long-role') f.request.role = 'a'.repeat(64);
    if (attack === 'projection') f.request.sourceProjectionSha256 = ['a'.repeat(64)];
    if (attack === 'settings') f.request.settingsSha256 = coreInspectionWorkerCapability.settingsSha256;
    if (attack === 'missing-projection') delete f.request.sourceProjectionSha256;
    if (attack === 'missing-auth') f.request.sourceAuthenticationSha256 = null;
    if (attack === 'v1-with-role') f.request.schema = 'orbis.core-inspection-worker-input.v1';
    await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(f.request));
    await expect(inspectCoreSource(f)).rejects.toThrow();
    expect(state.connected).toBe(0);
    expect(await fs.readdir(f.output)).toEqual([]);
  },
);

it.each(['current_user', 'session_user', 'unexpected'])(
  'refuses a different or malformed %s identity before inspecting the catalog',
  async (field) => {
    const f = await roleFixture();
    state.identity[field] = 'another_role';
    await expect(inspectCoreSource(f)).rejects.toThrow();
    expect(inspectCoreDatabaseStructure).not.toHaveBeenCalled();
    expect(await fs.readdir(f.output)).toEqual([]);
  },
);

it('rechecks the exact role and private search path after reading the source', async () => {
  const f = await roleFixture();
  state.queryHook = async (count) => {
    if (count === Object.keys(roleBoundCoreInspectionSettings).length + 2) state.identity.current_user = 'another_role';
  };
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(inspectCoreDatabase).toHaveBeenCalledOnce();
  expect(await fs.readdir(f.output)).toEqual([]);
});

it('refuses a role-overridden search path before querying captured data', async () => {
  const f = await roleFixture();
  state.settings.search_path = 'public, pg_catalog';
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(inspectCoreDatabaseStructure).not.toHaveBeenCalled();
  expect(await fs.readdir(f.output)).toEqual([]);
});

it('matches the independent Root profile settings and checks every effective SHOW value', async () => {
  const { stdout } = await promisify(execFile)('python3', [
    '-c',
    'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("profile",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.SETTINGS,sort_keys=True))',
    path.resolve('../../scripts/orbis-host-core-inspection-profile.py'),
  ]);
  expect(JSON.parse(stdout)).toEqual(coreInspectionSettings);
  expect(sha(canonicalCoreJson(JSON.parse(stdout)))).toBe(coreInspectionWorkerCapability.settingsSha256);
  state.settings = { ...coreInspectionSettings, archive_command: '(disabled)' };
  const client = {
    query: vi.fn(async (sql: string) => {
      const name = sql.slice(5);
      return { rows: [{ [name]: state.settings[name] }] };
    }),
  };
  await expect(verifyCoreInspectionSettings(client as never)).resolves.toBe(coreInspectionWorkerCapability.settingsSha256);
  state.settings.autovacuum = 'on';
  await expect(verifyCoreInspectionSettings(client as never)).rejects.toThrow();
});
it('matches the role-bound Root profile without changing the v1 settings or capability', async () => {
  const { stdout } = await promisify(execFile)('python3', [
    '-c',
    'import importlib.util,json,sys;s=importlib.util.spec_from_file_location("profile",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);image={"Id":m.PG17_ARM64_IMAGE,"Os":"linux","Architecture":"arm64","Config":{"Volumes":{"/var/lib/postgresql/data":{}}}};p=m.role_bound_image_profile(image,"captured_app_role","a"*64);print(json.dumps({"settings":m.settings_for(p),"profile":p},sort_keys=True))',
    path.resolve('../../scripts/orbis-host-core-inspection-profile.py'),
  ]);
  const actual = JSON.parse(stdout);
  expect(actual.settings).toEqual(roleBoundCoreInspectionSettings);
  expect(sha(canonicalCoreJson(actual.settings))).toBe(roleBoundCoreInspectionWorkerCapability.settingsSha256);
  expect(actual.profile).toMatchObject({
    schema: roleBoundCoreInspectionWorkerCapability.profile,
    role: 'captured_app_role',
    sourceProjectionSha256: 'a'.repeat(64),
  });
  expect(roleBoundCoreInspectionSettings).toEqual({ ...coreInspectionSettings, search_path: 'pg_catalog' });
  expect(coreInspectionWorkerCapability.profile).toBe('orbis.core-source-pg-inspection.v1');
  expect(coreInspectionWorkerCapability.settingsSha256).toBe('86efa76455380a719298af9684ba054fd42211877f69f0e1b2ac18da6ad0e72c');
});
it('requires the disabled SHOW sentinel without changing the fixed empty archive command', async () => {
  expect(coreInspectionSettings.archive_mode).toBe('off');
  expect(coreInspectionSettings.archive_command).toBe('');
  const settings: Record<string, string> = { ...coreInspectionSettings, archive_command: '(disabled)' };
  const client = {
    query: async (sql: string) => {
      const name = sql.slice(5);
      return { rows: [{ [name]: settings[name] }] };
    },
  };
  await expect(verifyCoreInspectionSettings(client as never)).resolves.toBe(coreInspectionWorkerCapability.settingsSha256);
  for (const invalid of ['', 'unexpected', '(DISABLED)']) {
    settings.archive_command = invalid;
    await expect(verifyCoreInspectionSettings(client as never)).rejects.toThrow();
  }
  settings.archive_command = '(disabled)';
  settings.archive_mode = 'on';
  await expect(verifyCoreInspectionSettings(client as never)).rejects.toThrow();
});
it('keeps source authentication in the trusted coordinator and emits only bounded hashes', async () => {
  const f = await fixture();
  const report = await inspectCoreSource(f);
  expect(state.config).toMatchObject({ host: '/var/run/postgresql', user: 'postgres', password: '', ssl: false });
  expect(state.queries.every((sql) => sql.startsWith('SHOW '))).toBe(true);
  expect(state.queries).toHaveLength(Object.keys(coreInspectionSettings).length * 2);
  expect(report).toMatchObject({
    permitSha256: f.request.permitSha256,
    sourceOwner: { sourceOwnerId: 11 },
    compatibilityRefusal: null,
    restoreAuthority: false,
  });
  const bytes = await fs.readFile(path.join(f.output, 'result.json'), 'utf8');
  expect(bytes).not.toContain('synthetic-source-jwt-key-for-inspection');
  expect((await fs.stat(path.join(f.output, 'result.json'))).mode & 0o7777).toBe(0o600);
  expect(vi.mocked(inspectCoreDatabase).mock.calls.at(0)?.[0].authentication.jwtSecret).toBe('synthetic-source-jwt-key-for-inspection');
  expect(coreSourceCatalogBootstrapEvidence).not.toHaveBeenCalled();
  expect(report).not.toHaveProperty('bootstrapSource');
  expect(report).not.toHaveProperty('evidenceScope');
});
it('reports unavailable source auth precisely without promoting structural inspection to authority', async () => {
  const f = await fixture(false);
  const report = await inspectCoreSource(f);
  expect(report).toMatchObject({ sourceOwner: null, compatibilityRefusal: 'source-authentication-unavailable', restoreAuthority: false });
  expect(inspectCoreDatabase).not.toHaveBeenCalled();
  expect(requireCoreSourceOwner).not.toHaveBeenCalled();
});
it.each(['image', 'settings', 'authentication', 'account-plaintext'] as const)('rejects invalid %s custody before SQL connection', async (attack) => {
  const f = await fixture();
  const request: Record<string, unknown> = { ...f.request };
  if (attack === 'image') request.sourceImageId = `sha256:${'f'.repeat(64)}`;
  if (attack === 'settings') request.settingsSha256 = 'f'.repeat(64);
  if (attack === 'authentication') request.sourceAuthenticationSha256 = 'f'.repeat(64);
  if (attack === 'account-plaintext') {
    const auth = JSON.stringify({ jwtSecret: 'synthetic-source-jwt-key-for-inspection', passkeys: null, password: 'forbidden-extra-account-field' });
    await fs.chmod(path.join(f.input, 'source-authentication.json'), 0o600);
    await fs.writeFile(path.join(f.input, 'source-authentication.json'), auth);
    request.sourceAuthenticationSha256 = sha(auth);
  }
  await fs.chmod(path.join(f.input, 'request.json'), 0o600);
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(request));
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(state.connected).toBe(0);
  expect(await fs.readdir(f.output)).toEqual([]);
});
it('refuses a catalog snapshot that changes before source authentication validation', async () => {
  const f = await fixture();
  vi.mocked(inspectCoreDatabase).mockResolvedValueOnce({
    token: {} as never,
    summary: {
      schema: 'orbis.core-database-snapshot.v1',
      sha256: 'f'.repeat(64),
      major: 17,
      catalogSha256: f.structure.catalogSha256,
      rows: f.structure.rows,
    },
  });
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(await fs.readdir(f.output)).toEqual([]);
});

it.each(['input', 'connect', 'settings-before', 'catalog', 'source-auth', 'settings-after', 'output'] as const)(
  'localizes %s failure without retaining secret-bearing error material',
  async (phase) => {
    const f = await fixture();
    const secret = 'private-key password SELECT secret FROM user /private/source-authentication.json';
    const error = Object.assign(new Error(secret), { code: '42501', query: secret, rows: [{ secret }], path: secret, stack: secret });
    if (phase === 'input') {
      await fs.chmod(path.join(f.input, 'request.json'), 0o600);
      await fs.writeFile(path.join(f.input, 'request.json'), secret);
    } else if (phase === 'connect') state.connectFailure = error;
    else if (phase === 'settings-before' || phase === 'settings-after') {
      state.queryFailure = error;
      state.queryFailureAt = phase === 'settings-before' ? 1 : Object.keys(coreInspectionSettings).length + 1;
    } else if (phase === 'catalog') vi.mocked(inspectCoreDatabaseStructure).mockRejectedValueOnce(error);
    else if (phase === 'source-auth') vi.mocked(inspectCoreDatabase).mockRejectedValueOnce(error);
    else {
      state.queryHook = async (count) => {
        if (count === Object.keys(coreInspectionSettings).length * 2) await fs.writeFile(path.join(f.output, 'result.json'), secret);
      };
    }
    const failure = await inspectCoreSource(f).catch((caught: unknown) => caught);
    const diagnostic = coreInspectionFailureDiagnostic(failure);
    expect(diagnostic).toEqual({ event: 'core-inspection-failed', phase, code: phase === 'input' || phase === 'output' ? 'unknown' : '42501' });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Core source inspection failed.');
    expect((failure as Error).cause).toBeUndefined();
    expect(Object.keys(failure as object)).toEqual([]);
    expect(String((failure as Error).stack)).not.toContain(secret);
  },
);

it.each(['ECONNREFUSED', '28P01', '57P03', 'XX000', '42501 secret-key', 'ZZ999', 'toString', undefined])(
  'emits only exact allowlisted failure code %s',
  async (code) => {
    const f = await fixture();
    state.connectFailure = { code, message: 'private-password', stack: '/private/key', phase: 'output' };
    const failure = await inspectCoreSource(f).catch((caught: unknown) => caught);
    expect(coreInspectionFailureDiagnostic(failure)).toEqual({
      event: 'core-inspection-failed',
      phase: 'connect',
      code: ['ECONNREFUSED', '28P01', '57P03', 'XX000'].includes(code as string) ? code : 'unknown',
    });
  },
);

it('ignores forged diagnostics and handles a throwing code getter without exposing it', async () => {
  const hostile = Object.defineProperty({ phase: 'catalog' }, 'code', {
    get() {
      throw new Error('private-key');
    },
  });
  expect(coreInspectionFailureDiagnostic(hostile)).toEqual({ event: 'core-inspection-failed', phase: 'input', code: 'unknown' });
  const f = await fixture();
  state.connectFailure = hostile;
  const failure = await inspectCoreSource(f).catch((caught: unknown) => caught);
  expect(coreInspectionFailureDiagnostic(failure)).toEqual({ event: 'core-inspection-failed', phase: 'connect', code: 'unknown' });
});

async function versionedFixture(id = 'pg14-debian-amd64.v1') {
  const f = await bootstrapFixture();
  const profile = corePgExecutionProfile(id);
  vi.spyOn(os, 'arch').mockReturnValue(profile.architecture === 'amd64' ? 'x64' : 'arm64');
  f.request.schema = 'orbis.core-inspection-worker-input.v4';
  f.request.executionProfile = id;
  f.request.sourceImageId = profile.imageId;
  f.request.settingsSha256 = sha(canonicalCoreJson(coreVersionedInspectionSettings(id)));
  state.settings = { ...coreVersionedInspectionSettings(id), archive_command: '(disabled)' };
  state.serverVersion = profile.major === 14 ? '140023' : '170006';
  state.locale = { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c' };
  const structure = { ...f.structure, major: profile.major };
  vi.mocked(inspectCoreDatabaseStructure).mockResolvedValue(structure);
  vi.mocked(inspectCoreDatabase).mockResolvedValue({
    token: {} as never,
    summary: {
      schema: 'orbis.core-database-snapshot.v1',
      sha256: structure.sha256,
      major: structure.major,
      catalogSha256: structure.catalogSha256,
      rows: structure.rows,
    },
  });
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(f.request));
  return { ...f, structure };
}

it.each(['pg14-debian-amd64.v1', 'pg17-alpine-arm64.v1'])('binds v4 inspection to profile, actual major and locale for %s', async (id) => {
  const f = await versionedFixture(id);
  const report = await inspectCoreSource(f);
  expect(report).toMatchObject({
    schema: 'orbis.core-inspection-worker-result.v4',
    executionProfile: id,
    bootstrapSource: f.evidence,
    databaseExecution: {
      profileId: id,
      major: f.structure.major,
      database: f.request.database,
      locale: { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c' },
    },
    compatibilityRefusal: 'source-effective-environment-unproved',
    restoreAuthority: false,
  });
  if (f.structure.major === 14) {
    expect(state.queries).not.toContain('SHOW archive_library');
    expect(state.queries.every((sql) => !sql.includes('datlocprovider'))).toBe(true);
    expect(report.databaseExecution?.localeProviderEvidence).toBe('postgresql14-libc-database-default');
  } else {
    expect(state.queries).toContain('SHOW archive_library');
    expect(report.databaseExecution?.localeProviderEvidence).toBe('pg_database.datlocprovider');
  }
  expect(state.queries.filter((sql) => sql === 'SHOW server_version_num')).toHaveLength(2);
  expect(JSON.parse(await fs.readFile(path.join(f.output, 'result.json'), 'utf8'))).toEqual(report);
});

it.each(['unknown-profile', 'wrong-image', 'wrong-architecture'])('refuses v4 %s before connecting', async (attack) => {
  const f = await versionedFixture();
  if (attack === 'unknown-profile') f.request.executionProfile = '__proto__';
  if (attack === 'wrong-image') f.request.sourceImageId = coreInspectionWorkerCapability.sourceImage;
  if (attack === 'wrong-architecture') vi.mocked(os.arch).mockReturnValue('arm64');
  await fs.writeFile(path.join(f.input, 'request.json'), canonicalCoreJson(f.request));
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(state.connected).toBe(0);
  expect(await fs.readdir(f.output)).toEqual([]);
});

it('refuses a different actual server major before reading source rows', async () => {
  const f = await versionedFixture();
  state.serverVersion = '170006';
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(state.queries).toEqual(['SHOW server_version_num']);
  expect(inspectCoreDatabaseStructure).not.toHaveBeenCalled();
});

it('retains every other PG14 isolation setting check', async () => {
  const f = await versionedFixture();
  delete state.settings.ssl;
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(inspectCoreDatabaseStructure).not.toHaveBeenCalled();
  expect(await fs.readdir(f.output)).toEqual([]);
});

it.each(['locale', 'version'])('refuses v4 %s drift before publishing a report', async (change) => {
  const f = await versionedFixture();
  state.queryHook = async () => {
    if (change === 'version' && state.queries.filter((sql) => sql === 'SHOW server_version_num').length === 2) state.serverVersion = '140024';
    if (change === 'locale' && state.queries.filter((sql) => sql.includes('FROM pg_catalog.pg_database d WHERE')).length === 2)
      state.locale.collate = 'C';
  };
  await expect(inspectCoreSource(f)).rejects.toThrow();
  expect(await fs.readdir(f.output)).toEqual([]);
});

it('exports v4 separately without changing the legacy fixed capability', () => {
  expect(versionedBootstrapSourceCoreInspectionWorkerCapability.protocol).toBe(4);
  expect(versionedBootstrapSourceCoreInspectionWorkerCapability.profiles['pg14-debian-amd64.v1']).toMatchObject({ major: 14, architecture: 'amd64' });
  expect(bootstrapSourceCoreInspectionWorkerCapability.protocol).toBe(3);
  expect(bootstrapSourceCoreInspectionWorkerCapability).not.toHaveProperty('profiles');
  expect(coreInspectionWorkerCapability).toMatchObject({ postgresqlMajor: 17, platform: { architecture: 'arm64' } });
});

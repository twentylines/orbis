import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse, populate } from 'dotenv';
import { EnvUtils } from '../env/env.utils';
import { canonicalCoreJson } from './time-machine-core-payload';
import {
  coreSourceConfigurationProfile,
  CoreSourceConfigurationError,
  projectCoreSourceConfiguration,
  projectCoreLiveAuthentication,
  type CoreLiveAuthenticationInput,
  type CoreSourceConfigurationInput,
} from './time-machine-core-source-configuration';

const key = 'inspection fixture key '.repeat(3).trimEnd();
const otherKey = 'different fixture key '.repeat(3).trimEnd();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const bound = (text: string | Buffer) => {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return { bytes, sha256: sha(bytes) };
};
function input(text = `JWT_SECRET=${key}\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis`): CoreSourceConfigurationInput {
  return {
    parserProfile: coreSourceConfigurationProfile,
    sourceWitnessSha256: '1'.repeat(64),
    sourceManifestSha256: '2'.repeat(64),
    controllerImageId: `sha256:${'3'.repeat(64)}`,
    controllerEnvironment: [`JWT_SECRET=${otherKey}`, 'POSTGRES_USERNAME=tipi', 'POSTGRES_DBNAME=orbis'],
    databaseEnvironment: ['POSTGRES_USER=tipi', 'POSTGRES_DB=orbis'],
    configuration: bound(text),
    passkeys: null,
  };
}
const selected = (value: CoreSourceConfigurationInput) =>
  JSON.parse(projectCoreSourceConfiguration(value).sourceAuthenticationBytes.toString('utf8'));

function liveInput(text = `JWT_SECRET="${key}" # file overrides Docker\n`): CoreLiveAuthenticationInput {
  return {
    parserProfile: coreSourceConfigurationProfile,
    liveSnapshotSha256: '1'.repeat(64),
    publicationSha256: '2'.repeat(64),
    controllerId: '3'.repeat(64),
    controllerImageId: `sha256:${'4'.repeat(64)}`,
    controllerEnvironment: [
      `JWT_SECRET=${otherKey}`,
      'POSTGRES_HOST=runtipi-db',
      'POSTGRES_USERNAME=tipi',
      'POSTGRES_DBNAME=orbis',
      'POSTGRES_PASSWORD=synthetic private password',
    ],
    databaseEnvironment: ['POSTGRES_USER=tipi', 'POSTGRES_DB=orbis', 'POSTGRES_PASSWORD=synthetic private password'],
    configuration: bound(text),
    passkeys: null,
  };
}

describe('current controller authentication candidate', () => {
  it.each(['5432', '5432.0'])('uses the application numeric port parser for %s', (port) => {
    const result = projectCoreLiveAuthentication(liveInput(`JWT_SECRET=${key}\nPOSTGRES_PORT=${port}`));
    expect(JSON.parse(result.databaseBytes.toString()).port).toBe(5432);
  });
  it.each([
    `JWT_SECRET="${key}" # quoted`,
    `export JWT_SECRET='${key}'`,
    `JWT_SECRET=${otherKey}\nJWT_SECRET=${key}`,
    `JWT_SECRET="${key}\\nsecond line"`,
    `JWT_SECRET='${key}=with=equals'`,
    `JWT_SECRET='${key}\${LITERAL}'`,
  ])('matches actual dotenv override and EnvUtils precedence for %s', (declaration) => {
    const value = liveInput(declaration);
    const inherited = Object.fromEntries(
      value.controllerEnvironment.map((item) => {
        const split = item.indexOf('=');
        return [item.slice(0, split), item.slice(split + 1)];
      }),
    );
    populate(inherited, parse(declaration), { override: true, quiet: true });
    const expected = { ...Object.fromEntries(new EnvUtils().envStringToMap(declaration)), ...inherited };
    const result = projectCoreLiveAuthentication(value);
    expect(JSON.parse(result.authenticationBytes.toString())).toEqual({ jwtSecret: expected.JWT_SECRET, passkeys: null });
    expect(JSON.parse(result.databaseBytes.toString())).toEqual({
      host: 'runtipi-db',
      port: 5432,
      user: 'tipi',
      password: 'synthetic private password',
      database: 'orbis',
    });
    expect(result.projection).toMatchObject({
      basis: 'current-controller-configuration-candidate',
      liveSnapshotSha256: value.liveSnapshotSha256,
      controllerId: value.controllerId,
      authenticationSha256: sha(result.authenticationBytes),
      databaseSha256: sha(result.databaseBytes),
      environmentProved: false,
      restoreAuthority: false,
      activation: false,
    });
    expect(JSON.stringify(result.projection)).not.toContain(key);
    expect(JSON.stringify(result.projection)).not.toContain('synthetic private password');
  });
  it('accepts an empty file with inherited settings and seals optional passkeys', () => {
    const value = liveInput('');
    value.passkeys = bound('{"credentials":[]}');
    const result = projectCoreLiveAuthentication(value);
    expect(JSON.parse(result.authenticationBytes.toString())).toEqual({ jwtSecret: otherKey, passkeys: { credentials: [] } });
    expect(result.projection.passkeysSha256).toBe(value.passkeys.sha256);
  });
  it.each([
    'POSTGRES_USERNAME=foreign',
    'POSTGRES_DBNAME=foreign',
    'POSTGRES_PASSWORD=foreign',
    'POSTGRES_PORT=5433',
    'POSTGRES_HOST=bad host',
    'DOTENV_KEY=unsupported',
  ])('refuses mismatched current configuration %s', (setting) => {
    expect(() => projectCoreLiveAuthentication(liveInput(`JWT_SECRET=${key}\n${setting}`))).toThrow(CoreSourceConfigurationError);
  });
  it('rejects changed bound files and duplicate inherited keys without exposing secret values', () => {
    for (const change of [
      (value: CoreLiveAuthenticationInput) => {
        value.configuration.sha256 = 'f'.repeat(64);
      },
      (value: CoreLiveAuthenticationInput) => {
        value.controllerEnvironment = [...value.controllerEnvironment, `JWT_SECRET=${key}`];
      },
    ]) {
      const value = liveInput();
      change(value);
      const error = (() => {
        try {
          projectCoreLiveAuthentication(value);
        } catch (error) {
          return error;
        }
      })();
      expect(error).toBeInstanceOf(CoreSourceConfigurationError);
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain('synthetic private password');
    }
  });
});

describe('captured configuration inspection candidates', () => {
  it('binds selected bytes and projection without claiming an effective environment or restore authority', () => {
    const source = input();
    const result = projectCoreSourceConfiguration(source);
    expect(JSON.parse(result.sourceAuthenticationBytes.toString('utf8'))).toEqual({ jwtSecret: key, passkeys: null });
    expect(result.projection).toMatchObject({
      schema: 'orbis.core-source-environment.v2',
      role: 'tipi',
      database: 'orbis',
      sourceWitnessSha256: source.sourceWitnessSha256,
      sourceManifestSha256: source.sourceManifestSha256,
      controllerImageId: source.controllerImageId,
      sourceAuthenticationSha256: sha(result.sourceAuthenticationBytes),
      configurationSha256: source.configuration.sha256,
      basis: 'captured-configuration-candidate',
      environmentProved: false,
      restoreAuthority: false,
    });
    expect(JSON.stringify(result.projection)).not.toContain(key);
    expect(result.sourceAuthenticationBytes.toString('utf8')).toBe(canonicalCoreJson({ jwtSecret: key, passkeys: null }));
  });

  it('supports a complete captured configuration without either live container creation environment', () => {
    const source = { ...input(), controllerEnvironment: null, databaseEnvironment: null };
    const result = projectCoreSourceConfiguration(source);
    expect(JSON.parse(result.sourceAuthenticationBytes.toString('utf8'))).toEqual({ jwtSecret: key, passkeys: null });
    expect(result.projection).toMatchObject({
      role: 'tipi',
      database: 'orbis',
      controllerEnvironmentSha256: null,
      databaseEnvironmentSha256: null,
      environmentBasis: 'captured-complete-configuration',
      environmentProved: false,
      restoreAuthority: false,
    });
  });

  it('requires all selected fields in captured-only mode and refuses partial creation environments', () => {
    for (const absent of ['JWT_SECRET', 'POSTGRES_USERNAME', 'POSTGRES_DBNAME']) {
      const source = input();
      source.configuration = bound(
        source.configuration.bytes
          .toString('utf8')
          .split('\n')
          .filter((line) => !line.startsWith(`${absent}=`))
          .join('\n'),
      );
      source.controllerEnvironment = null;
      source.databaseEnvironment = null;
      expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
    }
    for (const source of [
      { ...input(), controllerEnvironment: null },
      { ...input(), databaseEnvironment: null },
    ])
      expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
  });

  it.each([
    `JWT_SECRET="${key}" # a comment`,
    `export JWT_SECRET='${key}'`,
    `JWT_SECRET=${otherKey}\nJWT_SECRET=${key}`,
    `JWT_SECRET="${key}\\nsecond line"`,
    `JWT_SECRET='${key}=more=value'`,
    `JWT_SECRET='${key}\${UNCHANGED}'`,
    `JWT_SECRET=${key}\r\n`,
  ])('matches the actual ConfigurationService/EnvUtils precedence for %s', (declaration) => {
    const source = input(`${declaration}\nPOSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis`);
    const text = source.configuration.bytes.toString('utf8');
    const processEnvironment = Object.fromEntries(
      (source.controllerEnvironment ?? []).map((entry) => {
        const index = entry.indexOf('=');
        return [entry.slice(0, index), entry.slice(index + 1)];
      }),
    );
    populate(processEnvironment, parse(text), { override: true, quiet: true });
    const actual = { ...Object.fromEntries(new EnvUtils().envStringToMap(text)), ...processEnvironment };
    expect(selected(source).jwtSecret).toBe(actual.JWT_SECRET);
  });

  it('uses declared controller values for missing file settings, never this coordinator process environment', () => {
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'unrelated live key '.repeat(4);
    try {
      const source = input('POSTGRES_USERNAME=tipi\nPOSTGRES_DBNAME=orbis');
      expect(selected(source).jwtSecret).toBe(otherKey);
      source.controllerEnvironment = ['POSTGRES_USERNAME=tipi', 'POSTGRES_DBNAME=orbis'];
      expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
      expect(process.env.JWT_SECRET).toBe('unrelated live key '.repeat(4));
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });

  it('keeps passkey bytes bound and rejects malformed or absent-shaped documents', () => {
    const source = input();
    source.passkeys = bound('{ "version": 1, "users": {} }');
    expect(selected(source).passkeys).toEqual({ version: 1, users: {} });
    expect(projectCoreSourceConfiguration(source).projection.passkeysSha256).toBe(source.passkeys.sha256);
    for (const text of ['null', '[]', '"not a store"', 'true', '{']) {
      source.passkeys = bound(text);
      expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
    }
  });

  it('refuses mismatched configuration, manifests, parser profiles and environment bindings', () => {
    const variants: CoreSourceConfigurationInput[] = [];
    const changed = input();
    changed.configuration.bytes[0] = 0;
    variants.push(changed);
    variants.push({ ...input(), sourceManifestSha256: 'not a hash' });
    variants.push({ ...input(), controllerImageId: 'not an image' });
    variants.push({ ...input(), parserProfile: 'unreviewed-parser' as typeof coreSourceConfigurationProfile });
    variants.push({ ...input(), sourceWitnessSha256: 'A'.repeat(64) });
    variants.push({ ...input(), databaseEnvironment: ['POSTGRES_USER=another_role', 'POSTGRES_DB=orbis'] });
    variants.push({ ...input(), databaseEnvironment: ['POSTGRES_USER=tipi'] });
    variants.push({ ...input(), controllerEnvironment: [`JWT_SECRET=${key}`, `JWT_SECRET=${otherKey}`] });
    variants.push({ ...input(), controllerEnvironment: ['MISSING_SEPARATOR'] });
    variants.push({ ...input(), controllerEnvironment: ['BAD\0KEY=value'] });
    for (const source of variants) expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
  });

  it('does not guess postgres defaults and rejects role/database SQL syntax', () => {
    for (const role of ['', 'postgres;SELECT 1', 'some role', 'a'.repeat(64)]) {
      const source = input(`JWT_SECRET=${key}\nPOSTGRES_USERNAME=${role}\nPOSTGRES_DBNAME=orbis`);
      source.databaseEnvironment = [`POSTGRES_USER=${role}`, 'POSTGRES_DB=orbis'];
      expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
    }
    const source = input();
    source.databaseEnvironment = ['POSTGRES_DB=orbis'];
    expect(() => selected(source)).toThrow(CoreSourceConfigurationError);
  });

  it('refuses unsupported vault selection and bounds decoded input/output without leaking source errors', () => {
    for (const source of [
      { ...input(), controllerEnvironment: ['DOTENV_KEY=private vault fixture'] },
      input(`JWT_SECRET=${key}\nDOTENV_KEY=private vault fixture`),
      { ...input(), configuration: bound(Buffer.from([255, 254])) },
      { ...input(), configuration: bound('x'.repeat(1024 * 1024 + 1)) },
      { ...input(), configuration: bound('JWT_SECRET=secret\0content') },
      { ...input(), passkeys: bound(`{"value":"${'x'.repeat(2 * 1024 * 1024)}"}`) },
    ]) {
      try {
        selected(source);
        throw new Error('Unexpected acceptance');
      } catch (error) {
        expect(error).toBeInstanceOf(CoreSourceConfigurationError);
        expect((error as Error).message).toBe('Captured source configuration could not be inspected.');
        expect((error as Error).cause).toBeUndefined();
        expect(String(error)).not.toContain('private vault');
      }
    }
  });

  it('rejects extra authority claims and sanitizes throwing getters', () => {
    expect(() => selected({ ...input(), restoreAuthority: true } as CoreSourceConfigurationInput)).toThrow(CoreSourceConfigurationError);
    const source = input();
    Object.defineProperty(source, 'controllerImageId', {
      enumerable: true,
      get() {
        throw new Error('secret source diagnostic');
      },
    });
    try {
      selected(source);
      throw new Error('Unexpected acceptance');
    } catch (error) {
      expect((error as Error).message).toBe('Captured source configuration could not be inspected.');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

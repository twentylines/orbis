import { expect, it } from 'vitest';
import {
  corePgExecutionProfiles,
  corePgExecutionProfile,
  observeCorePgExecution,
  requireCorePgExecutionArchitecture,
} from './time-machine-core-pg-profile';

const pg14 = 'pg14-debian-amd64.v1';
const pg17 = 'pg17-alpine-arm64.v1';
function probe(version: unknown, locale: Record<string, unknown> = {}) {
  const queries: string[] = [];
  return {
    queries,
    client: {
      async query(sql: string) {
        queries.push(sql);
        return {
          rows: [
            sql === 'SHOW server_version_num'
              ? { server_version_num: version }
              : {
                  database: 'orbis',
                  encoding: 'UTF8',
                  collate: 'en_US.utf8',
                  ctype: 'en_US.utf8',
                  ...locale,
                },
          ],
        };
      },
    },
  };
}
it('keeps the profile registry immutable and binds exact images, majors and platforms', () => {
  expect(Object.isFrozen(corePgExecutionProfiles)).toBe(true);
  for (const profile of Object.values(corePgExecutionProfiles)) expect(Object.isFrozen(profile)).toBe(true);
  expect(corePgExecutionProfile(pg14)).toMatchObject({
    major: 14,
    architecture: 'amd64',
    imageId: 'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64',
  });
  expect(corePgExecutionProfile(pg17)).toMatchObject({ major: 17, architecture: 'arm64' });
  expect(requireCorePgExecutionArchitecture(pg14, 'x64')).toBe(corePgExecutionProfile(pg14));
  expect(requireCorePgExecutionArchitecture(pg17, 'arm64')).toBe(corePgExecutionProfile(pg17));
  expect(() => requireCorePgExecutionArchitecture(pg14, 'arm64')).toThrow();
  expect(() => requireCorePgExecutionArchitecture(pg17, 'x64')).toThrow();
});
it.each([null, undefined, 14, {}, '__proto__', 'constructor', 'toString', 'postgres:14', 'pg14-debian-arm64.v1', 'pg17-alpine-amd64.v1'])(
  'refuses an unknown or inherited execution profile %s',
  (id) => expect(() => corePgExecutionProfile(id)).toThrow(),
);
it('observes PG14 locale fields without querying a nonexistent provider column', async () => {
  const f = probe('140023');
  expect(await observeCorePgExecution(f.client, pg14, 'orbis')).toEqual({
    schema: 'orbis.core-pg-execution-observation.v1',
    profileId: pg14,
    serverVersionNum: 140023,
    major: 14,
    database: 'orbis',
    locale: { encoding: 'UTF8', collate: 'en_US.utf8', ctype: 'en_US.utf8', provider: 'c' },
    localeProviderEvidence: 'postgresql14-libc-database-default',
  });
  expect(f.queries).toHaveLength(2);
  expect(f.queries.every((sql) => !sql.includes('datlocprovider'))).toBe(true);
  expect(f.queries.every((sql) => /^(SHOW|SELECT) /.test(sql))).toBe(true);
});
it('reads the actual PG17 catalog provider rather than deriving it', async () => {
  const f = probe('170006', { provider: 'c' });
  expect(await observeCorePgExecution(f.client, pg17, 'orbis')).toMatchObject({
    major: 17,
    serverVersionNum: 170006,
    localeProviderEvidence: 'pg_database.datlocprovider',
  });
  expect(f.queries[1]).toContain('d.datlocprovider AS provider');
});
it.each([
  [pg14, '170006'],
  [pg17, '140023'],
  [pg14, '150010'],
  [pg14, '180000'],
])('refuses a different actual major for %s', async (id, version) => {
  const f = probe(version);
  await expect(observeCorePgExecution(f.client, id, 'orbis')).rejects.toThrow();
  expect(f.queries).toEqual(['SHOW server_version_num']);
});
it.each([null, undefined, 140023, '', '14.23', '0140023', '140023x', '99999'])('refuses malformed server-version evidence %s', async (version) => {
  const f = probe(version);
  await expect(observeCorePgExecution(f.client, pg14, 'orbis')).rejects.toThrow();
  expect(f.queries).toHaveLength(1);
});
it.each([{ database: 'another' }, { encoding: 'SQL_ASCII' }, { collate: '' }, { ctype: '\0' }, { collate: 'x'.repeat(257) }, { provider: 'c' }])(
  'refuses mismatched or malformed PG14 database locale evidence %j',
  async (locale) => {
    const f = probe('140023', locale);
    await expect(observeCorePgExecution(f.client, pg14, 'orbis')).rejects.toThrow();
  },
);
it.each(['i', 'b', '', null])('refuses unsupported PG17 provider %s', async (provider) => {
  const f = probe('170006', { provider });
  await expect(observeCorePgExecution(f.client, pg17, 'orbis')).rejects.toThrow();
});

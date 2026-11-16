export const corePgExecutionProfiles = Object.freeze({
  'pg17-alpine-arm64.v1': Object.freeze({
    imageId: 'sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24',
    os: 'linux',
    architecture: 'arm64',
    major: 17,
  } as const),
  'pg14-debian-amd64.v1': Object.freeze({
    imageId: 'sha256:d462928b1898dd74b749ef486797968828c1e7fc9befb5e5ca03a33bfbc32d64',
    os: 'linux',
    architecture: 'amd64',
    major: 14,
  } as const),
});
export type CorePgExecutionProfileId = keyof typeof corePgExecutionProfiles;
const fail = () => new Error('Core database execution profile could not be verified.');
export function corePgExecutionProfile(value: unknown) {
  if (typeof value !== 'string' || !Object.hasOwn(corePgExecutionProfiles, value)) throw fail();
  return corePgExecutionProfiles[value as CorePgExecutionProfileId];
}
export function requireCorePgExecutionArchitecture(id: unknown, architecture: string) {
  const profile = corePgExecutionProfile(id);
  if (profile.architecture !== (architecture === 'x64' ? 'amd64' : architecture)) throw fail();
  return profile;
}
type Query = { query(text: string): Promise<{ rows: Record<string, unknown>[] }> };
export type CorePgExecutionObservation = {
  schema: 'orbis.core-pg-execution-observation.v1';
  profileId: CorePgExecutionProfileId;
  serverVersionNum: number;
  major: 14 | 17;
  database: string;
  locale: { encoding: 'UTF8'; collate: string; ctype: string; provider: 'c' };
  localeProviderEvidence: 'postgresql14-libc-database-default' | 'pg_database.datlocprovider';
};
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const localeName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 256 &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);

export async function observeCorePgExecution(client: Query, profileId: unknown, database: string): Promise<CorePgExecutionObservation> {
  const profile = corePgExecutionProfile(profileId);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database)) throw fail();
  const version = await client.query('SHOW server_version_num');
  const raw = version.rows[0];
  if (
    version.rows.length !== 1 ||
    !exact(raw, ['server_version_num']) ||
    typeof raw.server_version_num !== 'string' ||
    !/^[1-9][0-9]{5}$/.test(raw.server_version_num)
  )
    throw fail();
  const serverVersionNum = Number(raw.server_version_num);
  if (Math.floor(serverVersionNum / 10000) !== profile.major) throw fail();
  const selected = await client.query(`SELECT pg_catalog.current_database() AS database,
    pg_catalog.pg_encoding_to_char(d.encoding) AS encoding,d.datcollate AS collate,d.datctype AS ctype${profile.major === 17 ? ',d.datlocprovider AS provider' : ''}
    FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`);
  const row = selected.rows[0];
  if (
    selected.rows.length !== 1 ||
    !exact(row, ['database', 'encoding', 'collate', 'ctype', ...(profile.major === 17 ? ['provider'] : [])]) ||
    row.database !== database ||
    row.encoding !== 'UTF8' ||
    !localeName(row.collate) ||
    !localeName(row.ctype) ||
    (profile.major === 17 && row.provider !== 'c')
  )
    throw fail();
  // PG14 has libc database locales and no datlocprovider column; label the
  // derived policy separately from a provider actually read from the catalog.
  return {
    schema: 'orbis.core-pg-execution-observation.v1',
    profileId: profileId as CorePgExecutionProfileId,
    serverVersionNum,
    major: profile.major,
    database,
    locale: { encoding: 'UTF8', collate: row.collate, ctype: row.ctype, provider: 'c' },
    localeProviderEvidence: profile.major === 14 ? 'postgresql14-libc-database-default' : 'pg_database.datlocprovider',
  };
}

import type { Client } from 'pg';
import { createHash } from 'node:crypto';
import { timeMachineHashSchema as hash, timeMachineIdSchema as uuid } from '@runtipi/common/schemas/time-machine';
import { inspectCoreDatabase, prepareCoreCleanTarget, verifyCoreCleanTarget, type CoreCleanTargetReconciliation } from './time-machine-core-database';
import { canonicalCoreJson } from './time-machine-core-payload';

type Connection = Pick<Client, 'query'>;
type Identity = {
  systemIdentifier: string;
  database: string;
  databaseOid: string;
  role: string;
  roleOid: string;
  serverVersionNum: number;
};
type Observed = Identity & { pid: string; startedAt: string; allowConnections: boolean };
export type CoreLiveDatabaseFenceIntent = {
  schema: 'orbis.core-live-database-fence.v1';
  id: string;
  nonce: string;
  rootIntentSha256: string;
  identity: Identity;
  originalAllowConnections: true;
  livePid: string;
  maintenancePid: string;
  startedAt: string;
};
type Journal = {
  persist: (intent: Readonly<CoreLiveDatabaseFenceIntent>) => Promise<void>;
  // The installed Root worker binds this to its durable, still-undecided transaction.
  verify: (intent: Readonly<CoreLiveDatabaseFenceIntent>) => Promise<void>;
};
declare const observationBrand: unique symbol;
export type CoreLiveDatabaseObservation = { readonly [observationBrand]: true };
declare const heldBrand: unique symbol;
export type HeldCoreLiveDatabase = { readonly [heldBrand]: true };
type Observation = { live: Connection; maintenance: Connection; current: Observed; control: Observed };
const observations = new WeakMap<CoreLiveDatabaseObservation, Observation>();
const held = new WeakMap<HeldCoreLiveDatabase, Observation & { intent: CoreLiveDatabaseFenceIntent; journal: Journal }>();
const used = new WeakSet<CoreLiveDatabaseObservation>();
const reconciled = new WeakSet<HeldCoreLiveDatabase>();
declare const liveReconciliationBrand: unique symbol;
export type HeldCoreLiveReconciliation = { readonly [liveReconciliationBrand]: true };
export type CoreLiveReconciliationEvidence = Readonly<{
  schema: 'orbis.core-live-target-reconciliation.v1';
  id: string;
  nonce: string;
  rootIntentSha256: string;
  fenceIntentSha256: string;
  destinationSha256: string;
  preparedSha256: string;
  destinationEvidence: 'held-live-database';
  activation: false;
  restoreAuthority: false;
  environmentProved: false;
}>;
type LiveReconciliation = {
  held: HeldCoreLiveDatabase;
  target: Connection;
  prepared: CoreCleanTargetReconciliation;
  evidence: CoreLiveReconciliationEvidence;
  destinationAuthentication: { jwtSecret: string; passkeys?: unknown };
  verify: (prepared: CoreCleanTargetReconciliation, evidence: CoreLiveReconciliationEvidence) => Promise<void>;
};
const liveReconciliations = new WeakMap<HeldCoreLiveReconciliation, LiveReconciliation>();
const digest = (value: unknown) => createHash('sha256').update(canonicalCoreJson(value)).digest('hex');
const names = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const number = (value: unknown, maximum: bigint) => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= maximum;
const oid = (value: unknown) => number(value, 4294967295n);
const pid = (value: unknown) => number(value, 2147483647n);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const identityKeys = ['systemIdentifier', 'database', 'databaseOid', 'role', 'roleOid', 'serverVersionNum'];
const validIdentity = (value: Identity) =>
  exact(value, identityKeys) &&
  number(value.systemIdentifier, 18446744073709551615n) &&
  typeof value.database === 'string' &&
  names.test(value.database) &&
  oid(value.databaseOid) &&
  typeof value.role === 'string' &&
  names.test(value.role) &&
  oid(value.roleOid) &&
  Number.isSafeInteger(value.serverVersionNum) &&
  [14, 17].includes(Math.floor(value.serverVersionNum / 10000));
const identity = (value: Observed): Identity => ({
  systemIdentifier: value.systemIdentifier,
  database: value.database,
  databaseOid: value.databaseOid,
  role: value.role,
  roleOid: value.roleOid,
  serverVersionNum: value.serverVersionNum,
});
const sameIdentity = (a: Identity, b: Identity) => identityKeys.every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const fail = () => new Error('Restore database access needs recovery. Existing server data has been kept.');
const quote = (name: string) => {
  if (!names.test(name)) throw fail();
  return `"${name}"`;
};
const observeSql = `SELECT c.system_identifier::text AS "systemIdentifier", d.datname AS "database",
  d.oid::text AS "databaseOid", current_user AS "role", r.oid::text AS "roleOid",
  current_setting('server_version_num')::integer AS "serverVersionNum", pg_backend_pid()::text AS "pid",
  EXTRACT(EPOCH FROM pg_postmaster_start_time())::text AS "startedAt", d.datallowconn AS "allowConnections"
  FROM pg_catalog.pg_database d CROSS JOIN pg_catalog.pg_control_system() c
  JOIN pg_catalog.pg_roles r ON r.rolname = current_user WHERE d.datname = current_database()`;
async function observe(client: Connection): Promise<Observed> {
  const result = await client.query(observeSql);
  const value = result.rows[0] as Observed;
  if (
    result.rows.length !== 1 ||
    !exact(value, [...identityKeys, 'pid', 'startedAt', 'allowConnections']) ||
    !validIdentity(identity(value)) ||
    !pid(value.pid) ||
    typeof value.startedAt !== 'string' ||
    value.startedAt.length < 1 ||
    value.startedAt.length > 128 ||
    typeof value.allowConnections !== 'boolean'
  )
    throw fail();
  return value;
}
function paired(current: Observed, control: Observed) {
  if (
    current.database === 'postgres' ||
    ['template0', 'template1'].includes(current.database) ||
    control.database !== 'postgres' ||
    current.pid === control.pid ||
    current.systemIdentifier !== control.systemIdentifier ||
    current.serverVersionNum !== control.serverVersionNum ||
    current.startedAt !== control.startedAt ||
    current.role !== control.role ||
    current.roleOid !== control.roleOid ||
    !control.allowConnections
  )
    throw fail();
}
async function isolated(value: Observation) {
  // Startup holds its database lock before publishing pg_stat_activity. Read
  // locks first so a backend cannot disappear between the two observations.
  const starting = await value.maintenance.query(
    `SELECT pid::text AS pid FROM pg_catalog.pg_locks WHERE locktype = 'object'
      AND classid = 'pg_catalog.pg_database'::regclass AND objid = $1::oid
      AND mode = 'RowExclusiveLock' ORDER BY pid`,
    [value.current.databaseOid],
  );
  if (starting.rows.length) throw fail();
  const result = await value.maintenance.query('SELECT pid::text AS pid FROM pg_catalog.pg_stat_activity WHERE datid = $1::oid ORDER BY pid', [
    value.current.databaseOid,
  ]);
  if (result.rows.length !== 1 || !exact(result.rows[0], ['pid']) || result.rows[0].pid !== value.current.pid) throw fail();
  const prepared = await value.maintenance.query('SELECT count(*)::text AS count FROM pg_catalog.pg_prepared_xacts WHERE database = $1', [
    value.current.database,
  ]);
  if (prepared.rows.length !== 1 || !exact(prepared.rows[0], ['count']) || prepared.rows[0].count !== '0') throw fail();
}
async function current(value: Observation, allowConnections: boolean) {
  const [live, control] = await Promise.all([observe(value.live), observe(value.maintenance)]);
  paired(live, control);
  if (
    !sameIdentity(live, value.current) ||
    !sameIdentity(control, value.control) ||
    live.pid !== value.current.pid ||
    control.pid !== value.control.pid ||
    live.startedAt !== value.current.startedAt ||
    live.allowConnections !== allowConnections
  )
    throw fail();
  await isolated(value);
}

/** Internal to the installed Root worker; observing does not grant restoration authority. */
export async function observeCoreLiveDatabase(options: {
  live: Connection;
  maintenance: Connection;
  expected: Identity;
  signal: AbortSignal;
}): Promise<CoreLiveDatabaseObservation> {
  options.signal.throwIfAborted();
  if (!validIdentity(options.expected) || options.live === options.maintenance) throw fail();
  const [live, control] = await Promise.all([observe(options.live), observe(options.maintenance)]);
  paired(live, control);
  if (!sameIdentity(live, options.expected) || !live.allowConnections) throw fail();
  const value = { live: options.live, maintenance: options.maintenance, current: live, control };
  await isolated(value);
  options.signal.throwIfAborted();
  const token = Object.freeze({}) as CoreLiveDatabaseObservation;
  observations.set(token, value);
  return token;
}

export async function holdCoreLiveDatabase(options: {
  observation: CoreLiveDatabaseObservation;
  id: string;
  nonce: string;
  rootIntentSha256: string;
  journal: Journal;
  signal: AbortSignal;
}): Promise<HeldCoreLiveDatabase> {
  const value = observations.get(options.observation);
  if (
    !value ||
    used.has(options.observation) ||
    !uuid.allows(options.id) ||
    !uuid.allows(options.nonce) ||
    options.id === options.nonce ||
    !hash.allows(options.rootIntentSha256) ||
    typeof options.journal?.persist !== 'function' ||
    typeof options.journal.verify !== 'function'
  )
    throw fail();
  options.signal.throwIfAborted();
  used.add(options.observation);
  const intent: CoreLiveDatabaseFenceIntent = Object.freeze({
    schema: 'orbis.core-live-database-fence.v1',
    id: options.id,
    nonce: options.nonce,
    rootIntentSha256: options.rootIntentSha256,
    identity: Object.freeze(identity(value.current)),
    originalAllowConnections: true,
    livePid: value.current.pid,
    maintenancePid: value.control.pid,
    startedAt: value.current.startedAt,
  });
  await current(value, true);
  await options.journal.persist(intent);
  await options.journal.verify(intent);
  options.signal.throwIfAborted();
  await current(value, true);
  // From this command onward, any failure requires the durable Root recovery decision.
  await value.maintenance.query(`ALTER DATABASE ${quote(intent.identity.database)} ALLOW_CONNECTIONS false`);
  await current(value, false);
  await options.journal.verify(intent);
  options.signal.throwIfAborted();
  const token = Object.freeze({}) as HeldCoreLiveDatabase;
  held.set(token, { ...value, intent, journal: options.journal });
  return token;
}

export async function assertCoreLiveDatabaseHeld(token: HeldCoreLiveDatabase, signal: AbortSignal) {
  const value = held.get(token);
  if (!value) throw fail();
  signal.throwIfAborted();
  await value.journal.verify(value.intent);
  await current(value, false);
  signal.throwIfAborted();
}

type LiveReconciliationOptions = Omit<Parameters<typeof prepareCoreCleanTarget>[0], 'destination' | 'authorize' | 'committed'> & {
  held: HeldCoreLiveDatabase;
  destinationAuthentication: { jwtSecret: string; passkeys?: unknown };
  authorize: LiveReconciliation['verify'];
  committed: LiveReconciliation['verify'];
  verify: LiveReconciliation['verify'];
};

/** Captures current destination rows through the sole held connection, never a saved inspection token. */
export async function reconcileCoreLiveDatabase(options: LiveReconciliationOptions) {
  const value = held.get(options.held);
  if (
    !value ||
    reconciled.has(options.held) ||
    options.target === value.live ||
    options.target === value.maintenance ||
    typeof options.authorize !== 'function' ||
    typeof options.committed !== 'function' ||
    typeof options.verify !== 'function'
  )
    throw fail();
  reconciled.add(options.held);
  const authentication = structuredClone(options.destinationAuthentication);
  await assertCoreLiveDatabaseHeld(options.held, options.signal);
  const destination = await inspectCoreDatabase({ client: value.live, authentication, signal: options.signal });
  await assertCoreLiveDatabaseHeld(options.held, options.signal);
  let evidence: CoreLiveReconciliationEvidence | undefined;
  const bound = (prepared: CoreCleanTargetReconciliation) => {
    if (
      prepared.destinationSha256 !== destination.summary.sha256 ||
      prepared.destinationIdentity.systemIdentifier !== value.intent.identity.systemIdentifier ||
      prepared.destinationIdentity.databaseOid !== value.intent.identity.databaseOid ||
      prepared.destinationIdentity.database !== value.intent.identity.database
    )
      throw fail();
    return Object.freeze({
      schema: 'orbis.core-live-target-reconciliation.v1' as const,
      id: prepared.id,
      nonce: prepared.nonce,
      rootIntentSha256: value.intent.rootIntentSha256,
      fenceIntentSha256: digest(value.intent),
      destinationSha256: destination.summary.sha256,
      preparedSha256: digest(prepared),
      destinationEvidence: 'held-live-database' as const,
      activation: false as const,
      restoreAuthority: false as const,
      environmentProved: false as const,
    });
  };
  const check = async (prepared: CoreCleanTargetReconciliation) => {
    if (!evidence || canonicalCoreJson(bound(prepared)) !== canonicalCoreJson(evidence)) throw fail();
    await assertCoreLiveDatabaseHeld(options.held, options.signal);
    await options.verify(prepared, evidence);
    await assertCoreLiveDatabaseHeld(options.held, options.signal);
  };
  const prepared = await prepareCoreCleanTarget({
    id: options.id,
    nonce: options.nonce,
    source: options.source,
    destination: destination.token,
    sourceOwnerId: options.sourceOwnerId,
    destinationOwnerId: options.destinationOwnerId,
    catalogOwnerIds: [...options.catalogOwnerIds],
    target: options.target,
    signal: options.signal,
    sequencePolicy: options.sequencePolicy,
    authorize: async (candidate) => {
      evidence = bound(candidate);
      await assertCoreLiveDatabaseHeld(options.held, options.signal);
      await options.authorize(candidate, evidence);
      await check(candidate);
    },
    committed: async (candidate) => {
      await check(candidate);
      if (!evidence) throw fail();
      await options.committed(candidate, evidence);
      await check(candidate);
    },
  });
  if (!evidence) throw fail();
  const record: LiveReconciliation = {
    held: options.held,
    target: options.target,
    prepared,
    evidence,
    destinationAuthentication: authentication,
    verify: options.verify,
  };
  const token = Object.freeze({}) as HeldCoreLiveReconciliation;
  liveReconciliations.set(token, record);
  await assertCoreLiveReconciliationHeld(token, options.signal);
  return Object.freeze({ token, prepared, evidence });
}

/** A persisted report alone cannot be used as a live hold after worker loss. */
export async function assertCoreLiveReconciliationHeld(token: HeldCoreLiveReconciliation, signal: AbortSignal) {
  const record = liveReconciliations.get(token);
  const value = record && held.get(record.held);
  if (!record || !value) throw fail();
  await assertCoreLiveDatabaseHeld(record.held, signal);
  await record.verify(record.prepared, record.evidence);
  await verifyCoreCleanTarget(record.target, record.prepared, signal);
  const current = await inspectCoreDatabase({ client: value.live, authentication: record.destinationAuthentication, signal });
  if (current.summary.sha256 !== record.evidence.destinationSha256) throw fail();
  await assertCoreLiveDatabaseHeld(record.held, signal);
  await record.verify(record.prepared, record.evidence);
  await assertCoreLiveDatabaseHeld(record.held, signal);
}

/** Root supplies its freshly checked rollback/abort decision, including after worker loss. */
export async function restoreCoreLiveDatabaseAdmission(options: {
  maintenance: Connection;
  intent: CoreLiveDatabaseFenceIntent;
  decision: 'rollback' | 'abort-before-activation';
  verify: (intent: Readonly<CoreLiveDatabaseFenceIntent>) => Promise<void>;
}) {
  const intent = options.intent;
  if (
    !exact(intent, ['schema', 'id', 'nonce', 'rootIntentSha256', 'identity', 'originalAllowConnections', 'livePid', 'maintenancePid', 'startedAt']) ||
    intent.schema !== 'orbis.core-live-database-fence.v1' ||
    !uuid.allows(intent.id) ||
    !uuid.allows(intent.nonce) ||
    intent.id === intent.nonce ||
    !hash.allows(intent.rootIntentSha256) ||
    !validIdentity(intent.identity) ||
    intent.originalAllowConnections !== true ||
    !pid(intent.livePid) ||
    !pid(intent.maintenancePid) ||
    intent.livePid === intent.maintenancePid ||
    typeof intent.startedAt !== 'string' ||
    !intent.startedAt ||
    intent.startedAt.length > 128 ||
    !['rollback', 'abort-before-activation'].includes(options.decision) ||
    typeof options.verify !== 'function'
  )
    throw fail();
  const frozen = Object.freeze({ ...intent, identity: Object.freeze({ ...intent.identity }) });
  const verify = async () => {
    await options.verify(frozen);
    const control = await observe(options.maintenance);
    if (
      control.database !== 'postgres' ||
      !control.allowConnections ||
      control.systemIdentifier !== frozen.identity.systemIdentifier ||
      control.role !== frozen.identity.role ||
      control.roleOid !== frozen.identity.roleOid ||
      control.serverVersionNum !== frozen.identity.serverVersionNum
    )
      throw fail();
    const result = await options.maintenance.query(
      'SELECT oid::text AS oid, datname AS name, datallowconn AS allowed FROM pg_catalog.pg_database WHERE oid = $1::oid',
      [frozen.identity.databaseOid],
    );
    const row = result.rows[0];
    if (
      result.rows.length !== 1 ||
      !exact(row, ['oid', 'name', 'allowed']) ||
      row.oid !== frozen.identity.databaseOid ||
      row.name !== frozen.identity.database ||
      typeof row.allowed !== 'boolean'
    )
      throw fail();
  };
  await verify();
  await options.maintenance.query(`ALTER DATABASE ${quote(frozen.identity.database)} ALLOW_CONNECTIONS true`);
  await verify();
  const check = await options.maintenance.query('SELECT datallowconn AS allowed FROM pg_catalog.pg_database WHERE oid = $1::oid', [
    frozen.identity.databaseOid,
  ]);
  if (check.rows.length !== 1 || !exact(check.rows[0], ['allowed']) || check.rows[0].allowed !== true) throw fail();
}

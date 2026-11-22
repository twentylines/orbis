import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { interpolateAppMigration, parseAppMigration } from './app-migration-plan';

const root = '/fixture/app-data/store/example';
const environment = { APP_DATA_DIR: root, ROLE_INPUT: 'new-value', EMPTY: '', FILLED: 'value' };
const source = (content: string) => {
  const bytes = Buffer.from(content);
  return { id: '001-example', bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const service = () => ({
  image: 'postgres:16.1',
  user: 'postgres',
  network_mode: 'none',
  volumes: ['${APP_DATA_DIR}/data/db:/var/lib/postgresql/data'],
  environment: { ROLE_INPUT: '${ROLE_INPUT}' },
  entrypoint: ['/bin/bash', '-euc'],
  command: ['test -s "$$PGDATA/PG_VERSION"; printf %s "$${ROLE_INPUT:?missing}"'],
});
const parse = (value: unknown, env = environment) => parseAppMigration(source(stringify(value)), { appDataHostPath: root, environment: env });
const plan = (extra: Record<string, unknown> = {}) => parse({ services: { migration: { ...service(), ...extra } } });

afterEach(() => {
  delete process.env.ORBIS_MIGRATION_AMBIENT;
});

describe('isolated migration definitions', () => {
  it('supports the upstream PostgreSQL shape without resolving its shell dollars twice', () => {
    const result = plan();
    expect(result.image).toBe('postgres:16.1');
    expect(result.user).toBe('postgres');
    expect(result.command).toEqual(['test -s "$PGDATA/PG_VERSION"; printf %s "${ROLE_INPUT:?missing}"']);
    expect(result.environment).toEqual({ ROLE_INPUT: 'new-value' });
    expect(result.mounts).toEqual([{ source: root + '/data/db', target: '/var/lib/postgresql/data', readOnly: false }]);
    expect(result.temporary).toEqual([{ target: '/tmp', sizeBytes: 64 * 1024 * 1024, mode: 0o1777 }]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.environment)).toBe(true);
  });

  it('does not inherit the Orbis process environment or undeclared app fields', () => {
    process.env.ORBIS_MIGRATION_AMBIENT = 'ambient-only';
    const result = plan({ environment: { EXPLICIT: '${ROLE_INPUT}', ABSENT: '${ORBIS_MIGRATION_AMBIENT}' } });
    expect(result.environment).toEqual({ EXPLICIT: 'new-value', ABSENT: '' });
    expect(Object.hasOwn(result.environment, 'APP_DATA_DIR')).toBe(false);
    expect(Object.hasOwn(result.environment, 'FILLED')).toBe(false);
  });

  it('supports mapping/list inheritance and literal dollar values with one interpolation pass', () => {
    const input = { ...environment, ROLE_INPUT: '$LITERAL' };
    expect(parse({ services: { migration: { ...service(), environment: { ROLE_INPUT: null, NUMBER: 17 } } } }, input).environment).toEqual({
      ROLE_INPUT: '$LITERAL',
      NUMBER: '17',
    });
    expect(
      parse({ services: { migration: { ...service(), environment: ['ROLE_INPUT', 'COPY=${ROLE_INPUT}', 'DOLLAR=$$HOME', 'UNSET'] } } }, input)
        .environment,
    ).toEqual({ ROLE_INPUT: '$LITERAL', COPY: '$LITERAL', DOLLAR: '$HOME' });
  });

  it('normalizes numeric IDs and finite numeric environment values without accepting invalid UID ranges', () => {
    expect(plan({ user: 999, environment: { FRACTION: 1.5 } }).user).toBe('999');
    expect(plan({ environment: { FRACTION: 1.5 } }).environment).toEqual({ FRACTION: '1.5' });
    expect(() => plan({ user: '4294967296' })).toThrow();
    expect(() => plan({ user: -1 })).toThrow();
  });

  it('supports equivalent long read-only binds without automatic host path creation', () => {
    expect(
      plan({
        volumes: [
          {
            type: 'bind',
            source: '${APP_DATA_DIR}/input',
            target: '/input',
            read_only: true,
            bind: { create_host_path: false, propagation: 'rprivate' },
          },
        ],
      }).mounts,
    ).toEqual([{ source: root + '/input', target: '/input', readOnly: true }]);
  });

  it('supports bounded temporary storage and avoids a duplicate default scratch mount', () => {
    expect(plan({ tmpfs: ['/tmp:size=8m,mode=1777', '/run:size=4m,mode=0700,uid=999,gid=999'] }).temporary).toEqual([
      { target: '/tmp', sizeBytes: 8 * 1024 * 1024, mode: 0o1777 },
      { target: '/run', sizeBytes: 4 * 1024 * 1024, mode: 0o700, uid: 999, gid: 999 },
    ]);
    const result = plan({ volumes: [{ type: 'tmpfs', target: '/scratch', tmpfs: { size: 8192, mode: 0o700 } }] });
    expect(result.temporary[0]).toEqual({ target: '/scratch', sizeBytes: 8192, mode: 0o700 });
    expect(plan({ volumes: ['${APP_DATA_DIR}/scratch:/tmp'] }).temporary).toEqual([]);
  });

  it.each([
    'build',
    'env_file',
    'depends_on',
    'extends',
    'volumes_from',
    'privileged',
    'ports',
    'pid',
    'ipc',
    'devices',
    'cap_add',
    'networks',
    'extra_hosts',
    'secrets',
    'configs',
    'labels',
    'container_name',
    'hostname',
  ])('refuses the unsupported service field %s before execution', (key) => {
    expect(() => plan({ [key]: [] })).toThrow('supported isolated service');
  });

  it.each([
    { network_mode: 'host' },
    { read_only: false },
    { restart: 'always' },
    { stdin_open: true },
    { tty: true },
    { init: false },
    { entrypoint: '/bin/bash' },
    { command: 'echo value' },
    { cap_drop: [] },
    { platform: 'windows/amd64' },
    { user: '../root' },
    { environment: ['A=1', 'A=2'] },
    { environment: { ENABLED: true } },
  ])('refuses incompatible execution values %#', (extra) => {
    expect(() => plan(extra)).toThrow('supported isolated service');
  });

  it.each([
    ['db:/data'],
    ['./data:/data'],
    ['${APP_DATA_DIR}-other:/data'],
    ['${APP_DATA_DIR}/../other:/data'],
    ['${APP_DATA_DIR}:/proc'],
    ['${APP_DATA_DIR}:/run/docker.sock'],
    ['${APP_DATA_DIR}/one:/data', '${APP_DATA_DIR}/two:/data/nested'],
    ['${APP_DATA_DIR}:/data:z'],
    [{ type: 'bind', source: root, target: '/data', bind: { create_host_path: true } }],
    [{ type: 'bind', source: root, target: '/data', bind: { propagation: 'rshared' } }],
  ])('refuses storage that is external, ambiguous or modifies host mount state %#', (...volumes) => {
    expect(() => plan({ volumes })).toThrow('supported isolated service');
  });

  it.each(['/tmp:size=1g', '/tmp:size=2', '/tmp:size=4m,size=8m', '/tmp:mode=4777', '/tmp:exec', '/tmp:uid=-1', '/tmp:size=8m=bad'])(
    'refuses unsafe temporary mount options %s',
    (tmpfs) => {
      expect(() => plan({ tmpfs })).toThrow('supported isolated service');
    },
  );

  it('bounds aggregate expansion across otherwise valid individual environment fields', () => {
    const exported = Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [`VALUE_${index}`, '${ROLE_INPUT}']));
    expect(() =>
      parse({ services: { migration: { ...service(), environment: exported } } }, { ...environment, ROLE_INPUT: 'v'.repeat(65536) }),
    ).toThrow();
  });

  it('rejects multiple services, external includes, duplicate keys, aliases, tags and mutated source bytes', () => {
    expect(() => parse({ services: { migration: service(), sibling: service() } })).toThrow();
    expect(() => parse({ include: ['elsewhere.yml'], services: { migration: service() } })).toThrow();
    for (const value of [
      'services:\n  migration:\n    image: one\n    image: two\n',
      'services:\n  migration: &alias {image: postgres}\n  other: *alias\n',
      'services: !untrusted {migration: {image: postgres}}\n',
    ])
      expect(() => parseAppMigration(source(value), { appDataHostPath: root, environment })).toThrow('supported isolated service');
    const changed = source(stringify({ services: { migration: service() } }));
    changed.bytes[0] = 0;
    expect(() => parseAppMigration(changed, { appDataHostPath: root, environment })).toThrow();
  });
});

describe('Compose interpolation without ambient variables', () => {
  const map = new Map(Object.entries(environment));
  it.each([
    ['$FILLED', 'value'],
    ['${UNKNOWN}', ''],
    ['${EMPTY-default}', ''],
    ['${EMPTY:-default}', 'default'],
    ['${UNKNOWN:-${FILLED}}', 'value'],
    ['${FILLED:+yes}', 'yes'],
    ['${EMPTY:+yes}', ''],
    ['${EMPTY+yes}', 'yes'],
    ['${UNKNOWN+yes}', ''],
    ['$${FILLED}', '${FILLED}'],
    ['$$PGDATA', '$PGDATA'],
    ['$1 $(date) $', '$1 $(date) $'],
  ])('matches %s', (input, expected) => {
    expect(interpolateAppMigration(input, map)).toBe(expected);
  });

  it('preserves required-variable behavior and never echoes supplied reasons or input values', () => {
    for (const input of ['${UNKNOWN?private reason}', '${EMPTY:?private reason}', '${FILLED:-${UNKNOWN?private reason}}'])
      expect(() => interpolateAppMigration(input, map)).toThrow('App migration environment is incomplete.');
    for (const input of ['${}', '${NO', '${FILLED:other}', '${NAME/foo/bar}'])
      expect(() => interpolateAppMigration(input, map)).toThrow('supported isolated service');
  });

  it('bounds every expansion and nested operand before allocating excessive output', () => {
    expect(() => interpolateAppMigration('$VALUE'.repeat(100), new Map([['VALUE', 'v'.repeat(65536)]]))).toThrow();
    const nested = '${UNSET:-'.repeat(20) + 'value' + '}'.repeat(20);
    expect(() => interpolateAppMigration(nested, map)).toThrow();
  });
});

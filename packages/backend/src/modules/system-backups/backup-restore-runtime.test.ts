import type Dockerode from 'dockerode';
import { expect, it } from 'vitest';
import { snapshotRestoreContainer, verifyRestoreVerifierMounts } from './backup-restore-runtime';

type InspectFixture = {
  Id: string;
  Name: string;
  Image: string;
  HostConfig: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    OomKillDisable?: boolean | null;
    Privileged: boolean;
    PortBindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    CapAdd: string[] | null;
  };
  Config: { Env: string[]; Labels: Record<string, string>; Image: string };
  Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
  NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
  State: { Running: boolean };
};

function fixture(overrides: Partial<InspectFixture> = {}): InspectFixture {
  const value: InspectFixture = {
    Id: 'a'.repeat(64),
    Name: '/orbis-controller',
    Image: `sha256:${'b'.repeat(64)}`,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      OomKillDisable: null,
      Privileged: false,
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] },
      CapAdd: ['NET_ADMIN'],
    },
    Config: { Env: ['NODE_ENV=production'], Labels: { 'com.orbis.role': 'controller' }, Image: 'orbis:stable' },
    Mounts: [
      { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
      { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
    ],
    NetworkSettings: { Networks: { orbis: { NetworkID: 'c'.repeat(64) } } },
    State: { Running: true },
    ...overrides,
  };
  return value;
}

const snapshot = (value: InspectFixture) => snapshotRestoreContainer(value as unknown as Dockerode.ContainerInspectInfo);

type Mount = InspectFixture['Mounts'][number];
const originalStorageMounts: Mount[] = [
  { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: true },
  { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
  { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
];
const verifierMounts = (): Mount[] => [
  { Type: 'bind', Source: '/srv/orbis/data', Destination: '/data', RW: false },
  { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: false },
  { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
  { Type: 'bind', Source: '/srv/orbis/data/logs', Destination: '/data/logs', RW: true },
];
function verifyMountSet(mounts: Mount[]) {
  verifyRestoreVerifierMounts(
    fixture({ Mounts: originalStorageMounts }) as unknown as Dockerode.ContainerInspectInfo,
    fixture({ Mounts: mounts }) as unknown as Dockerode.ContainerInspectInfo,
  );
}
function changeMount(mounts: Mount[], index: number, changes: Partial<Mount>) {
  const mount = mounts[index];
  if (!mount) throw new Error('Missing test mount fixture.');
  Object.assign(mount, changes);
}

it('accepts exactly the verifier data, app-data, cache, and logs mounts with required access', () => {
  expect(() => verifyMountSet(verifierMounts())).not.toThrow();
});

it('accepts the production child-bind layout through the runtime verifier boundary', () => {
  const names = ['state', 'apps', 'repos', 'media', 'user-config', 'traefik', 'backups', 'logs', '.env'];
  const original = [
    ...names.map((name) => ({ Type: 'bind', Source: `/srv/orbis/${name}`, Destination: `/data/${name}`, RW: true })),
    { Type: 'bind', Source: '/srv/orbis/app-data', Destination: '/app-data', RW: true },
    { Type: 'bind', Source: '/srv/orbis/cache', Destination: '/cache', RW: true },
    { Type: 'bind', Source: '/proc/stat', Destination: '/host/proc/stat', RW: false },
  ];
  const verifier = original
    .filter((mount) => !mount.Destination.startsWith('/host/'))
    .map((mount) => ({ ...mount, RW: ['/data/logs', '/cache'].includes(mount.Destination) }));
  expect(() =>
    verifyRestoreVerifierMounts(
      fixture({ Mounts: original }) as unknown as Dockerode.ContainerInspectInfo,
      fixture({ Mounts: verifier }) as unknown as Dockerode.ContainerInspectInfo,
    ),
  ).not.toThrow();
  const writable = verifier.find((mount) => mount.Destination === '/data/.env');
  if (!writable) throw new Error('Missing fixture environment mount');
  writable.RW = true;
  expect(() =>
    verifyRestoreVerifierMounts(
      fixture({ Mounts: original }) as unknown as Dockerode.ContainerInspectInfo,
      fixture({ Mounts: verifier }) as unknown as Dockerode.ContainerInspectInfo,
    ),
  ).toThrow();
});

it.each([
  [
    'read-only Docker socket',
    (mounts: Mount[]) => mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: false }),
  ],
  [
    'unexpected read-only host directory',
    (mounts: Mount[]) => mounts.push({ Type: 'bind', Source: '/srv/secrets', Destination: '/secrets', RW: false }),
  ],
  ['duplicate destination', (mounts: Mount[]) => changeMount(mounts, 3, { Destination: '/data' })],
  ['mismatched source', (mounts: Mount[]) => changeMount(mounts, 0, { Source: '/srv/other/data' })],
  ['mismatched access', (mounts: Mount[]) => changeMount(mounts, 1, { RW: true })],
  [
    'missing mount',
    (mounts: Mount[]) => {
      mounts.pop();
    },
  ],
] as const)('rejects verifier mount configuration with %s', (_name, mutate) => {
  const mounts = verifierMounts();
  mutate(mounts);

  expect(() => verifyMountSet(mounts)).toThrow();
});

it('normalizes mount ordering, running state, and OOM flag nullability without changing identity', () => {
  const original = fixture();
  const reordered = fixture({
    Mounts: [...original.Mounts].reverse(),
    State: { Running: false },
    HostConfig: { ...original.HostConfig, OomKillDisable: false },
  });
  const undefinedFlag = fixture({ HostConfig: { ...original.HostConfig, OomKillDisable: undefined } });

  const originalSnapshot = snapshot(original);
  expect(snapshot(reordered).fingerprint).toBe(originalSnapshot.fingerprint);
  expect(snapshot(undefinedFlag).fingerprint).toBe(originalSnapshot.fingerprint);
  expect(snapshot(reordered).running).toBe(false);
  expect(snapshot(original).running).toBe(true);
});

it('fingerprints explicit OOM kill disable and reports restart policy separately', () => {
  const original = fixture();
  const oomDisabled = fixture({ HostConfig: { ...original.HostConfig, OomKillDisable: true } });
  const alternateRestartPolicy = fixture({
    HostConfig: { ...original.HostConfig, RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 } },
  });

  expect(snapshot(oomDisabled).fingerprint).not.toBe(snapshot(original).fingerprint);
  expect(snapshot(alternateRestartPolicy).fingerprint).toBe(snapshot(original).fingerprint);
  expect(snapshot(alternateRestartPolicy).restart).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 });
});

it('ignores volatile network endpoint IDs but fingerprints network membership', () => {
  const original = fixture();
  const differentEndpoint = fixture({ NetworkSettings: { Networks: { orbis: { NetworkID: 'e'.repeat(64) } } } });
  const additionalNetwork = fixture({
    NetworkSettings: { Networks: { orbis: { NetworkID: 'e'.repeat(64) }, extra: { NetworkID: 'f'.repeat(64) } } },
  });
  const removedNetwork = fixture({ NetworkSettings: { Networks: {} } });

  expect(snapshot(differentEndpoint).fingerprint).toBe(snapshot(original).fingerprint);
  expect(snapshot(additionalNetwork).fingerprint).not.toBe(snapshot(original).fingerprint);
  expect(snapshot(removedNetwork).fingerprint).not.toBe(snapshot(original).fingerprint);
});

it.each([
  [
    'mount source',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { Source: '/srv/other/data' });
    },
  ],
  [
    'mount destination',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { Destination: '/other' });
    },
  ],
  [
    'mount access',
    (value: InspectFixture) => {
      changeMount(value.Mounts, 0, { RW: false });
    },
  ],
  [
    'environment',
    (value: InspectFixture) => {
      value.Config.Env.push('FEATURE_FLAG=1');
    },
  ],
  [
    'labels',
    (value: InspectFixture) => {
      value.Config.Labels.owner = 'fixture';
    },
  ],
  [
    'image ID',
    (value: InspectFixture) => {
      value.Image = `sha256:${'d'.repeat(64)}`;
    },
  ],
  [
    'privileged mode',
    (value: InspectFixture) => {
      value.HostConfig.Privileged = true;
    },
  ],
  [
    'port binding',
    (value: InspectFixture) => {
      value.HostConfig.PortBindings['80/tcp'] = [{ HostPort: '8081' }];
    },
  ],
  [
    'capabilities',
    (value: InspectFixture) => {
      value.HostConfig.CapAdd = ['NET_ADMIN', 'SYS_ADMIN'];
    },
  ],
] as const)('changes the fingerprint when %s changes', (_name, mutate) => {
  const changed = fixture();
  mutate(changed as unknown as InspectFixture);

  expect(snapshot(changed).fingerprint).not.toBe(snapshot(fixture()).fingerprint);
});

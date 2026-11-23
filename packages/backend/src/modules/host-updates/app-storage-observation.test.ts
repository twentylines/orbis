import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppStorageWitness, decodeAppStorageObservation } from './app-storage-observation';

const canonical = (value: unknown): string =>
  value !== null && typeof value === 'object'
    ? '{' +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    : JSON.stringify(value);
const h = (letter: string) => letter.repeat(64);
const fixture = () => ({
  schema: 'orbis.app-storage-observation.v1',
  appUrn: 'demo:store',
  nonce: h('a'),
  controller: { id: h('b'), imageId: `sha256:${h('c')}`, startedAt: 'fixture-start', definitionSha256: h('d') },
  daemonSha256: h('e'),
  dockerSocket: { device: '1', inode: '22' },
  hostBasePath: '/fixture/app-data',
  hostPath: '/fixture/app-data/store/demo',
  containerPath: '/app-data/store/demo',
  directory: { device: '1', inode: '33', uid: 1000, gid: 1000, mode: 0o775 },
  mountTablesSha256: h('f'),
  controllerNamespace: '1:44',
});
const signed = <T extends object>(value: T) => ({
  ...value,
  bindingSha256: createHash('sha256')
    .update('orbis.app-storage-observation.v1\n' + canonical(value))
    .digest('hex'),
});
const decode = (value: unknown) => decodeAppStorageObservation(value, { appUrn: 'demo:store', nonce: h('a') });

describe('private app storage metadata', () => {
  it('verifies exact app, nonce, derived paths and canonical digest while preserving normal user-owned data', () => {
    const raw = signed(fixture());
    const value = decode(raw);
    expect(value.directory.mode).toBe(0o775);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.directory)).toBe(true);
    expect(value).not.toBeInstanceOf(AppStorageWitness);
    raw.controller.imageId = `sha256:${h('0')}`;
    expect(value.controller.imageId).toBe(`sha256:${h('c')}`);
  });
  it.each([
    { appUrn: 'other:store' },
    { nonce: h('0') },
    { hostPath: '/fixture/app-data/store/other' },
    { containerPath: '/app-data/store/demo/child' },
    { hostBasePath: '/fixture/../app-data' },
    { controllerNamespace: '1:0' },
    { daemonSha256: 'invalid' },
    { extra: true },
    { directory: { device: '1', inode: '33', uid: -1, gid: 1000, mode: 0o775 } },
    { dockerSocket: { device: '1', inode: '22', path: '/arbitrary' } },
  ])('rejects mismatched or unsupported metadata even with a newly computed digest %#', (change) => {
    expect(() => decode(signed({ ...fixture(), ...change }))).toThrow('could not be verified');
  });
  it('rejects altered bytes without treating the claimed digest as authority', () => {
    const value = signed(fixture());
    value.directory.inode = '44';
    expect(() => decode(value)).toThrow();
  });
});

describe('app storage identifier compatibility', () => {
  const forApp = (appUrn: string) => {
    const [app, rawStore] = appUrn.split(':');
    const store = rawStore?.replace(/[\r\n\u2028\u2029]+$/g, '');
    return signed({ ...fixture(), appUrn, hostPath: `/fixture/app-data/${store}/${app}`, containerPath: `/app-data/${store}/${app}` });
  };
  it.each([
    'demo:store',
    'demo:_user',
    'demo:_private',
    'Demo:My_store',
    '-demo:store',
    'demo.v1:store-1',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store',
    'demo:ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
  ])('preserves the complete supported identifier %s', (appUrn) => {
    const decoded = decodeAppStorageObservation(forApp(appUrn), { appUrn, nonce: h('a') });
    expect(decoded.appUrn).toBe(appUrn);
    expect(decoded.containerPath).toBe(forApp(appUrn).containerPath);
  });
  it.each([
    '.:store',
    '..:store',
    'demo:..',
    'demo:.store',
    'demo:store/other',
    'demo:store\\other',
    'demo:store:other',
    'demo:/store',
    'demo:store\u0000',
    'demo:\nstore',
    '\u00e9:store',
    'demo:%2e%2e',
    'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx:store',
    'demo:sssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss',
    'demo:',
    ':store',
    'demo:store\n',
    'demo:store\r',
    'demo:store\r\n',
    'demo:store\u2028',
    'demo:store\u2029',
  ])('rejects traversal, ambiguous or oversized identifiers %s', (appUrn) => {
    expect(() => decodeAppStorageObservation(forApp(appUrn), { appUrn, nonce: h('a') })).toThrow('could not be verified');
  });
});

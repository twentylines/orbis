import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodePinnedCompose, projectAppVolumePins } from './app-volume-compose';
import type { AppVolumePins } from './app-volume-pins';

const pins: AppVolumePins = {
  version: 1,
  appUrn: 'app:store',
  project: 'app_store',
  services: [{ name: 'app', mounts: [{ target: '/config', volume: 'restored-fixture', readOnly: false }] }],
};
const base = () => ({
  name: 'app_store',
  services: {
    app: {
      image: 'image:fixture',
      environment: { LITERAL: 'value$UNSET' },
      command: ['literal$(text)'],
      volumes: [
        { type: 'bind', source: '/original/config', target: '/config', read_only: true, bind: { propagation: 'rshared' } },
        { type: 'volume', source: 'unrelated', target: '/keep', volume: { subpath: 'preserved' } },
      ],
    },
  },
  volumes: { unrelated: { name: 'original-volume' } },
});
const local = `orbis_retained_${createHash('sha256').update('restored-fixture').digest('hex')}`;

it.each(['bind', 'volume', 'tmpfs'])('projects a complete %s replacement and preserves unrelated configuration', (kind) => {
  const value = base();
  const original = value.services.app.volumes[0];
  if (!original) throw new Error('Missing fixture mount');
  Object.assign(original, { type: kind, volume: { subpath: 'old-subpath' }, tmpfs: { size: 4096 } });
  const before = structuredClone(value);
  const projected = projectAppVolumePins(value, pins) as ReturnType<typeof base>;
  expect(projected.services.app.volumes.find((mount) => mount.target === '/config')).toEqual({
    type: 'volume',
    source: local,
    target: '/config',
    read_only: false,
    volume: { nocopy: true },
  });
  expect(projected.services.app.volumes.find((mount) => mount.target === '/keep')).toEqual(before.services.app.volumes[1]);
  expect(projected.services.app.environment).toEqual(before.services.app.environment);
  expect(projected.services.app.command).toEqual(before.services.app.command);
  expect(value).toEqual(before);
});

it('preserves the exported Compose dollar escapes without a second transformation', () => {
  const exported = base();
  exported.services.app.environment.LITERAL = 'value$$UNSET';
  exported.services.app.command = ['literal$$(text)'];
  const document = JSON.parse(encodePinnedCompose(exported, pins).toString());
  expect(document.services.app.environment.LITERAL).toBe('value$$UNSET');
  expect(document.services.app.command).toEqual(['literal$$(text)']);
});

it.each([
  'reserved-volume-key',
  'reserved-source',
  'same-external-name',
  'wrong-project',
  'missing-service',
  'unresolved-env',
  'extends',
  'duplicate-target',
])('refuses %s before the app can be recreated', (change) => {
  const value: Record<string, unknown> = base();
  const services = value.services as Record<string, Record<string, unknown>>;
  const app = services.app;
  if (!app) throw new Error('Missing fixture service');
  if (change === 'reserved-volume-key') Object.assign(value.volumes as object, { [local]: { name: 'different-data' } });
  if (change === 'reserved-source') app.volumes = [{ type: 'volume', source: local, target: '/other' }];
  if (change === 'same-external-name') Object.assign(value.volumes as object, { alias: { name: 'restored-fixture', external: true } });
  if (change === 'wrong-project') value.name = 'other_store';
  if (change === 'missing-service') delete services.app;
  if (change === 'unresolved-env') app.env_file = ['/unfrozen.env'];
  if (change === 'extends') app.extends = { file: '/unfrozen.yml', service: 'other' };
  if (change === 'duplicate-target') app.volumes = [{ target: '/config' }, { target: '/config' }];
  expect(() => projectAppVolumePins(value, pins)).toThrow();
});

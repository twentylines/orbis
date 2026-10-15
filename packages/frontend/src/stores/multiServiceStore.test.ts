import { convertLegacyToYaml } from '@runtipi/common/schemas';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveConfirmation } from '@/desktop/confirmation';
import { useMultiServiceStore } from './multiServiceStore';

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe('multiServiceStore', () => {
  beforeEach(() => {
    resolveConfirmation(false);
    useMultiServiceStore.getState().resetToDefaults();
  });

  afterEach(() => resolveConfirmation(false));

  const dirtyJson = () => {
    useMultiServiceStore.setState({
      services: [
        { _id: 'web-stable', name: 'web', image: 'nginx:alpine', isMain: true, internalPort: 80 },
        { _id: 'worker-stable', name: 'worker', image: 'alpine:3.22', isMain: false },
      ],
      composeExtras: { volumes: { saved_data: null } },
      activeService: 'json',
      isDirty: true,
      error: '',
    });
  };
  const snapshot = () => {
    const { services, composeExtras, activeService, isDirty, error } = useMultiServiceStore.getState();
    return structuredClone({ services, composeExtras, activeService, isDirty, error });
  };
  const actions = {
    switch: () => useMultiServiceStore.getState().setActiveService(0),
    add: () => useMultiServiceStore.getState().addService(),
    remove: () => useMultiServiceStore.getState().removeService(1),
  };

  it.each(['switch', 'add', 'remove'] as const)('keeps dirty JSON and stored services when %s is cancelled', async (action) => {
    dirtyJson();
    const before = snapshot();
    let settled = false;
    const pending = actions[action]().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(snapshot()).toEqual(before);
    resolveConfirmation(false);
    await pending;

    expect(settled).toBe(true);
    expect(snapshot()).toEqual(before);
  });

  it.each(['switch', 'add', 'remove'] as const)('applies %s only after dirty JSON discard is accepted', async (action) => {
    dirtyJson();
    const before = snapshot();
    const pending = actions[action]();
    expect(snapshot()).toEqual(before);

    resolveConfirmation(true);
    await pending;

    const after = snapshot();
    expect(after.isDirty).toBe(false);
    expect(after.composeExtras).toEqual(before.composeExtras);
    if (action === 'switch') {
      expect(after.activeService).toBe(0);
      expect(after.services).toEqual(before.services);
    } else if (action === 'add') {
      expect(after.activeService).toBe(2);
      expect(after.services).toHaveLength(3);
      expect(after.services.slice(0, 2)).toEqual(before.services);
      expect(after.services[2]).toMatchObject({ name: 'service-3', image: '', isMain: false });
      expect(after.services[2]?._id).toMatch(/^service-/);
    } else {
      expect(after.activeService).toBe(0);
      expect(after.services).toEqual([before.services[0]]);
    }
  });

  it('declines a second action without consuming the first pending confirmation', async () => {
    dirtyJson();
    const before = snapshot();
    const first = actions.switch();

    await actions.remove();
    expect(snapshot()).toEqual(before);
    resolveConfirmation(true);
    await first;

    expect(snapshot()).toEqual({ ...before, activeService: 0, isDirty: false });
  });

  it.each(['switch', 'add', 'remove'] as const)('does not apply stale %s after the editor store resets during confirmation', async (action) => {
    dirtyJson();
    const pending = actions[action]();
    useMultiServiceStore.getState().resetToDefaults();
    const reset = snapshot();

    resolveConfirmation(true);
    await pending;

    expect(snapshot()).toEqual(reset);
  });

  it('preserves a newer stored edit when a pending add confirmation becomes stale', async () => {
    dirtyJson();
    const pending = actions.add();
    const current = useMultiServiceStore.getState().services[0];
    if (!current) throw new Error('Expected the seeded web service');
    useMultiServiceStore.getState().updateService(0, { ...current, image: 'nginx:newer-saved-value' });
    const edited = snapshot();

    resolveConfirmation(true);
    await pending;

    expect(snapshot()).toEqual(edited);
    expect(useMultiServiceStore.getState().services[0]?.image).toBe('nginx:newer-saved-value');
  });

  it('preserves root-level volumes when YAML is saved and rebuilt from store state', () => {
    useMultiServiceStore.getState().updateFromYaml(
      parse(`x-runtipi:
  schema_version: 2
services:
  dockhand:
    image: fnsys/dockhand:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - dockhand_data:/app/data
    x-runtipi:
      internal_port: "3000"
      is_main: true
volumes:
  dockhand_data:
`),
    );

    const { services, composeExtras } = useMultiServiceStore.getState();
    const rebuiltYaml = {
      ...convertLegacyToYaml({
        schemaVersion: 2,
        services: services.map(({ _id, ...service }) => service),
      }),
      ...composeExtras,
    };

    expect(rebuiltYaml).toMatchObject({
      services: {
        dockhand: {
          image: 'fnsys/dockhand:latest',
        },
      },
      volumes: {
        dockhand_data: null,
      },
    });
    expect(stringify(rebuiltYaml, { nullStr: '' })).toContain(`volumes:
  dockhand_data:
`);
  });
});

/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { saveSetupSteps, setupAppUpdateSteps, setupScheduleAllowsNext, type SetupAppChoices } from './setup-save';
import type { AppUpdateRule } from '@/desktop/automatic-updates-api';

test('onboarding blocks Next for edited invalid times even after automation is disabled', () => {
  for (const time of ['', null, '25:00', '1500']) {
    expect(setupScheduleAllowsNext(time, true, true)).toBe(false);
    expect(setupScheduleAllowsNext(time, true, false)).toBe(false);
    expect(setupScheduleAllowsNext(time, false, true)).toBe(false);
  }
  expect(setupScheduleAllowsNext('15:00', true, true)).toBe(true);
  expect(setupScheduleAllowsNext('15:00', true, false)).toBe(true);
  expect(setupScheduleAllowsNext(null, false, false)).toBe(true);
});

test('retries only requests that did not succeed and keeps completion last', async () => {
  const receipts = new Map<string, string>();
  const calls: string[] = [];
  let disconnected = true;
  const steps = [
    {
      id: 'schedule',
      value: { enabled: true },
      save: async () => {
        calls.push('schedule');
      },
    },
    {
      id: 'app',
      value: { urn: 'reader:store' },
      save: async () => {
        calls.push('app');
        if (disconnected) throw new Error('Disconnected');
      },
    },
    {
      id: 'complete',
      value: { name: 'Hades' },
      save: async () => {
        calls.push('complete');
      },
    },
  ];
  await expect(saveSetupSteps(steps, receipts, () => {})).rejects.toThrow('Disconnected');
  expect(calls).toEqual(['schedule', 'app']);
  disconnected = false;
  await saveSetupSteps(steps, receipts, () => {});
  expect(calls).toEqual(['schedule', 'app', 'app', 'complete']);
});

test('a changed choice is saved again while identical successful choices remain acknowledged', async () => {
  const receipts = new Map<string, string>();
  let saves = 0;
  const save = async () => {
    saves++;
  };
  await saveSetupSteps([{ id: 'appearance', value: { preset: 'frost' }, save }], receipts, () => {});
  await saveSetupSteps([{ id: 'appearance', value: { preset: 'frost' }, save }], receipts, () => {});
  expect(saves).toBe(1);
  await saveSetupSteps([{ id: 'appearance', value: { preset: 'blush' }, save }], receipts, () => {});
  expect(saves).toBe(2);
});

test('apps with the same visible name retain separate save receipts', async () => {
  const receipts = new Map<string, string>();
  const calls: string[] = [];
  const steps = ['reader:store-one', 'reader:store-two'].map((urn) => ({
    id: `app:${urn}`,
    label: 'Saving Reader',
    value: urn,
    save: async () => {
      calls.push(urn);
    },
  }));
  await saveSetupSteps(steps, receipts, () => {});
  await saveSetupSteps(steps, receipts, () => {});
  expect(calls).toEqual(['reader:store-one', 'reader:store-two']);
});

test('deselecting an app after a partial save restores its previous custom schedule', async () => {
  const touched: SetupAppChoices = new Map();
  const receipts = new Map<string, string>();
  const rules = new Map<string, AppUpdateRule>([['reader:store', { mode: 'custom', time: '05:30' }]]);
  const api = {
    read: async (urn: string) => ({ rule: rules.get(urn) ?? { mode: 'disabled' as const } }),
    save: async (urn: string, rule: AppUpdateRule) => {
      rules.set(urn, rule);
    },
  };
  const steps = setupAppUpdateSteps([{ urn: 'reader:store', name: 'Reader' }], touched, api);
  await saveSetupSteps(steps, receipts, () => {});
  expect(rules.get('reader:store')).toEqual({ mode: 'global' });
  await saveSetupSteps(setupAppUpdateSteps([], touched, api), receipts, () => {});
  expect(rules.get('reader:store')).toEqual({ mode: 'custom', time: '05:30' });
});

test('a lost save response still permits restoring the prior app policy', async () => {
  const touched: SetupAppChoices = new Map();
  const receipts = new Map<string, string>();
  let rule: AppUpdateRule = { mode: 'disabled' };
  let loseResponse = true;
  const api = {
    read: async () => ({ rule }),
    save: async (_urn: string, next: AppUpdateRule) => {
      rule = next;
      if (loseResponse) throw new Error('Response lost after saving');
    },
  };
  await expect(saveSetupSteps(setupAppUpdateSteps([{ urn: 'reader:store', name: 'Reader' }], touched, api), receipts, () => {})).rejects.toThrow(
    'Response lost after saving',
  );
  expect(rule).toEqual({ mode: 'global' });
  loseResponse = false;
  await saveSetupSteps(setupAppUpdateSteps([], touched, api), receipts, () => {});
  expect(rule).toEqual({ mode: 'disabled' });
});

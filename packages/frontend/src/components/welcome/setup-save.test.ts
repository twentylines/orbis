/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { saveSetupSteps } from './setup-save';

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

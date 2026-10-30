import { expect, test } from 'bun:test';
import { saveSettingsPlan, type SettingsSaveEntry } from './settings-save-plan';

test('every dirty section validates before any settings are written', async () => {
  const events: string[] = [];
  const entry = (section: 'general' | 'updates', valid: boolean): SettingsSaveEntry => ({
    section,
    dirty: true,
    pending: false,
    prepare: async () => {
      events.push(`validate-${section}`);
      return valid ? async () => void events.push(`save-${section}`) : null;
    },
  });
  expect(await saveSettingsPlan([entry('general', true), entry('updates', false)])).toEqual({ saved: 0, failed: 'updates', invalid: true });
  expect(events).toEqual(['validate-general', 'validate-updates']);
});

test('successful slices are acknowledged in sequence while failed and unattempted changes remain pending', async () => {
  const events: string[] = [];
  const entries: SettingsSaveEntry[] = ['general', 'store', 'updates'].map((section) => ({
    section: section as SettingsSaveEntry['section'],
    dirty: true,
    pending: false,
    prepare: async () => async () => {
      events.push(section);
      if (section === 'store') throw new Error('private upstream detail');
    },
  }));
  expect(await saveSettingsPlan(entries)).toEqual({ saved: 1, failed: 'store' });
  expect(events).toEqual(['general', 'store']);
});

test('clean or currently saving forms cannot start another write', async () => {
  let calls = 0;
  const entry: SettingsSaveEntry = {
    section: 'general',
    dirty: false,
    pending: false,
    prepare: async () => {
      calls++;
      return async () => {};
    },
  };
  expect(await saveSettingsPlan([entry])).toEqual({ saved: 0 });
  expect(await saveSettingsPlan([{ ...entry, dirty: true, pending: true }])).toEqual({ saved: 0 });
  expect(calls).toBe(0);
});

test('a cancelled session never prepares or dispatches queued sections', async () => {
  const controller = new AbortController();
  let calls = 0;
  const entry: SettingsSaveEntry = {
    section: 'general',
    dirty: true,
    pending: false,
    prepare: async () => {
      calls++;
      return async () => {
        calls++;
      };
    },
  };
  controller.abort(new Error('Private cancellation reason'));
  expect(await saveSettingsPlan([entry], controller.signal)).toEqual({ saved: 0, cancelled: true });
  expect(calls).toBe(0);
});

test('cancellation while preparing does not dispatch any already validated section', async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const entries: SettingsSaveEntry[] = ['general', 'updates'].map((section) => ({
    section: section as SettingsSaveEntry['section'],
    dirty: true,
    pending: false,
    prepare: async () => {
      events.push(`prepare-${section}`);
      if (section === 'updates') controller.abort();
      return async () => {
        events.push(`commit-${section}`);
      };
    },
  }));
  expect(await saveSettingsPlan(entries, controller.signal)).toEqual({ saved: 0, cancelled: true });
  expect(events).toEqual(['prepare-general', 'prepare-updates']);
});

test('cancellation after a confirmed section retains its partial success and blocks the next write', async () => {
  const controller = new AbortController();
  const committed: string[] = [];
  const entries: SettingsSaveEntry[] = ['general', 'updates'].map((section) => ({
    section: section as SettingsSaveEntry['section'],
    dirty: true,
    pending: false,
    prepare: async () => async () => {
      committed.push(section);
      controller.abort();
    },
  }));
  expect(await saveSettingsPlan(entries, controller.signal)).toEqual({ saved: 1, cancelled: true });
  expect(committed).toEqual(['general']);
});

test('a cancelled later write keeps earlier acknowledgements without exposing the abort reason', async () => {
  const controller = new AbortController();
  const entries: SettingsSaveEntry[] = ['general', 'updates', 'store'].map((section) => ({
    section: section as SettingsSaveEntry['section'],
    dirty: true,
    pending: false,
    prepare: async () => async () => {
      if (section === 'updates') {
        controller.abort();
        throw new Error('Private upstream detail');
      }
    },
  }));
  const result = await saveSettingsPlan(entries, controller.signal);
  expect(result).toEqual({ saved: 1, cancelled: true });
  expect(JSON.stringify(result)).not.toContain('Private');
});

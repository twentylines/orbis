import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { defaultTimeMachinePreferences } from '@runtipi/common/schemas/time-machine';
import { manualProtectionUpdate, ProtectionChoice, readManualProtection, saveManualProtection } from './protection-choice';
test('onboarding protection controls only the supported manual-capture preference', () => {
  const current = { ...defaultTimeMachinePreferences(), revision: 12 };
  expect(manualProtectionUpdate(current, false)).toEqual({
    enabled: false,
    schedule: current.schedule,
    beforeUpdate: false,
    beforeRestart: false,
    excludedApps: [],
    expectedRevision: 12,
  });
  const html = renderToStaticMarkup(<ProtectionChoice enabled={true} onChange={() => undefined} />);
  expect(html).toContain('Enable');
  expect(html).toContain('Later');
  expect(html).toContain('aria-label="Time Machine"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).not.toContain('Automatic');
  expect(html).not.toContain('scheduled');
});

test('onboarding reads and saves manual protection through the authenticated Time Machine routes with the latest revision', async () => {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  const current = { ...defaultTimeMachinePreferences(), revision: 18, excludedApps: [] };
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json(init?.method === 'PUT' ? { ...current, revision: 19, enabled: false } : current);
    }) as typeof fetch;
    const signal = new AbortController().signal;
    expect(await readManualProtection(signal)).toEqual(current);
    expect((await saveManualProtection(false, signal)).enabled).toBe(false);
    expect(requests.map(({ url, init }) => [url, init?.method])).toEqual([
      ['/api/system-backups/time-machine/preferences', 'GET'],
      ['/api/system-backups/time-machine/preferences', 'GET'],
      ['/api/system-backups/time-machine/preferences', 'PUT'],
    ]);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual(manualProtectionUpdate(current, false));
    for (const { init } of requests) {
      expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store');
      expect(init?.redirect).toBe('error');
    }
  } finally {
    globalThis.fetch = original;
  }
});

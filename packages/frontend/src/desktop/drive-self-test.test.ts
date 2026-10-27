import { expect, test } from 'bun:test';
import { driveSelfTestIssue, requestDriveSelfTest } from './drive-self-test';

const drive = { id: `drive:${'a'.repeat(24)}`, kind: 'short' as const };

test('rechecks the latest drive state before starting while keeping abort available', () => {
  const current = { selfTest: { supported: true, running: false, remainingPercent: null, shortMinutes: null, extendedMinutes: null } };
  expect(driveSelfTestIssue('short', current, false)).toBeNull();
  expect(driveSelfTestIssue(undefined, undefined, true)).toBeNull();
  expect(driveSelfTestIssue('abort', undefined, true)).toBeNull();
  expect(driveSelfTestIssue('short', current, true)).toContain('readings are delayed');
  expect(driveSelfTestIssue('extended', undefined, false)).toContain('no longer reported');
  expect(driveSelfTestIssue('short', { selfTest: { ...current.selfTest, running: true } }, false)).toContain('already running');
  expect(driveSelfTestIssue('short', { selfTest: { ...current.selfTest, supported: false } }, false)).toContain('self-test support');
});

test('sends a confirmed local self-test through the host command endpoint', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const message = await requestDriveSelfTest(drive, async (url, init) => {
    captured = { url, init };
    return Response.json({ accepted: true, message: 'Short test started.' }, { status: 202 });
  });
  expect(captured?.url).toBe('/api/host-updates/drives/test');
  expect(captured?.init).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
  expect(JSON.parse(String(captured?.init.body))).toEqual(drive);
  expect(captured?.init.signal).toBeInstanceOf(AbortSignal);
  expect(message).toBe('Short test started.');
});

test('sends a paired-server test as a cluster command instead of a read resource', async () => {
  await requestDriveSelfTest({ ...drive, kind: 'extended', serverId: 'server/secondary' }, async (url, init) => {
    expect(url).toBe('/api/cluster/servers/server%2Fsecondary/command');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'drive-self-test', payload: { ...drive, kind: 'extended' } });
    return Response.json({ accepted: true }, { status: 201 });
  });
});

test('shows a useful error when a proxy returns a non-JSON failure', async () => {
  await expect(requestDriveSelfTest(drive, async () => new Response('<html>Unavailable</html>', { status: 502 }))).rejects.toThrow(
    'The self-test request could not be completed. Try again.',
  );
});

test('does not accept an HTTP success without explicit device acceptance', async () => {
  for (const body of [null, {}, { accepted: false }, { accepted: 'true' }]) {
    await expect(requestDriveSelfTest(drive, async () => Response.json(body))).rejects.toThrow('The self-test request could not be completed.');
  }
});

test('preserves a device rejection reason and supplies a success fallback', async () => {
  await expect(
    requestDriveSelfTest(drive, async () => Response.json({ accepted: false, message: 'This drive already has a test running.' }, { status: 409 })),
  ).rejects.toThrow('This drive already has a test running.');
  expect(await requestDriveSelfTest(drive, async () => Response.json({ accepted: true }))).toBe('Self-test request accepted.');
});

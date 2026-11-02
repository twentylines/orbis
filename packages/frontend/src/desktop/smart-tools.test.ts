import { expect, test } from 'bun:test';
import { smartToolsRequest, SmartToolsRequestError } from './smart-tools';

test('SMART install review has no caller-controlled package or script URL', async () => {
  await smartToolsRequest('plan', {}, null, async (url, init) => {
    expect(url).toBe('/api/host-updates/drives/tools/plan');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(JSON.parse(String(init?.body))).toEqual({});
    return Response.json({ planId: 'reviewed' });
  });
});

test('paired SMART installs use the authenticated command channel and exact reviewed plan', async () => {
  await smartToolsRequest('apply', { planId: 'reviewed' }, 'other/server', async (url, init) => {
    expect(url).toBe('/api/cluster/servers/other%2Fserver/command');
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'smart-tools-apply', payload: { planId: 'reviewed' } });
    return Response.json({ jobId: 'reviewed', state: 'queued' });
  });
});

test('installation progress reads the real durable package job', async () => {
  await smartToolsRequest('status', {}, null, async (url, init) => {
    expect(url).toBe('/api/host-updates/packages/job');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    return Response.json({ available: true, job: null });
  });
});

test('HTTP rejections retain their reason and unknown responses never claim success', async () => {
  await expect(
    smartToolsRequest('apply', {}, null, async () => Response.json({ message: 'Host package manager is busy.' }, { status: 409 })),
  ).rejects.toThrow('Host package manager is busy');
  await expect(smartToolsRequest('apply', {}, null, async () => new Response('gateway error', { status: 502 }))).rejects.toThrow(
    'Refresh the task status',
  );
});

test('definite request rejection permits review while gateway uncertainty stays fenced', async () => {
  for (const [status, rejected] of [
    [409, true],
    [502, false],
  ] as const) {
    try {
      await smartToolsRequest('apply', {}, null, async () => Response.json({ message: 'Request stopped.' }, { status }));
      throw new Error('Unexpected acceptance');
    } catch (error) {
      expect(error).toBeInstanceOf(SmartToolsRequestError);
      expect((error as SmartToolsRequestError).rejected).toBe(rejected);
    }
  }
});

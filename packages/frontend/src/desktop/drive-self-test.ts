import type { DriveHealth } from '@runtipi/common/schemas/drive-health';

export type DriveSelfTest = { id: string; kind: 'short' | 'extended' | 'abort'; serverId?: string | null };

export function driveSelfTestIssue(kind: DriveSelfTest['kind'] | undefined, drive: Pick<DriveHealth, 'selfTest'> | undefined, delayed: boolean) {
  if (!kind || kind === 'abort') return null;
  if (delayed) return 'Drive readings are delayed. Cancel and refresh before starting a test.';
  if (!drive) return 'This drive is no longer reported. Cancel and refresh the drive list.';
  if (drive.selfTest.running) return 'A self-test is already running on this drive.';
  if (!drive.selfTest.supported) return 'This drive is no longer reporting self-test support.';
  return null;
}

export async function requestDriveSelfTest(
  { id, kind, serverId }: DriveSelfTest,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<string> {
  const payload = { id, kind };
  const response = await request(serverId ? `/api/cluster/servers/${encodeURIComponent(serverId)}/command` : '/api/host-updates/drives/test', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(serverId ? { action: 'drive-self-test', payload } : payload),
    signal: AbortSignal.timeout(40_000),
  });
  const result = (await response.json().catch(() => null)) as { accepted?: unknown; message?: unknown } | null;
  const message = typeof result?.message === 'string' ? result.message : null;
  if (!response.ok || result?.accepted !== true) throw new Error(message || 'The self-test request could not be completed. Try again.');
  return message || 'Self-test request accepted.';
}

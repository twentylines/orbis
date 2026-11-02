import type { SmartToolsPlan } from '@runtipi/common/schemas/drive-health';

export type SmartToolsJob = {
  id: string;
  kind?: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'interrupted';
  message?: string;
};

export class SmartToolsRequestError extends Error {
  constructor(
    message: string,
    readonly rejected: boolean,
  ) {
    super(message);
  }
}

export async function smartToolsRequest<T>(
  action: 'plan' | 'apply' | 'status',
  payload: Record<string, unknown>,
  serverId?: string | null,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<T> {
  const status = action === 'status';
  const response = await request(
    serverId
      ? `/api/cluster/servers/${encodeURIComponent(serverId)}/command`
      : status
        ? '/api/host-updates/packages/job'
        : `/api/host-updates/drives/tools/${action}`,
    {
      method: !serverId && status ? 'GET' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(!serverId && status ? {} : { body: JSON.stringify(serverId ? { action: `smart-tools-${action}`, payload } : payload) }),
      signal: AbortSignal.timeout(65_000),
    },
  );
  const result = (await response.json().catch(() => null)) as { message?: unknown } | null;
  if (!response.ok || !result) {
    throw new SmartToolsRequestError(
      typeof result?.message === 'string' ? result.message : 'SMART tools could not be reached. Refresh the task status before retrying.',
      [400, 401, 403, 404, 409, 422].includes(response.status),
    );
  }
  return result as T;
}

export const reviewSmartTools = (serverId?: string | null) => smartToolsRequest<SmartToolsPlan>('plan', {}, serverId);

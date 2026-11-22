const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/;
const phases = ['planned', 'accepted', 'stopping', 'held', 'return-accepted', 'returning', 'complete', 'cancelled'] as const;

export type ControllerHandoff = {
  planId: string;
  state: (typeof phases)[number] | 'attention';
  phase: (typeof phases)[number];
  portalUrl: string;
  expiresAtMs: number;
};

export class ControllerHandoffError extends Error {
  constructor(readonly status?: number) {
    super(
      status === 401 || status === 403 ? 'Sign in again before entering recovery.' : 'Recovery readiness could not be verified. Try again shortly.',
    );
  }
}

export function parseControllerHandoff(value: unknown, portalUrl: string, planId?: string): ControllerHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControllerHandoffError();
  const item = value as Record<string, unknown>;
  const url = URL.canParse(portalUrl) ? new URL(portalUrl) : null;
  if (
    Object.keys(item).length !== 5 ||
    !['planId', 'state', 'phase', 'portalUrl', 'expiresAtMs'].every((key) => Object.hasOwn(item, key)) ||
    typeof item.planId !== 'string' ||
    !identifier.test(item.planId) ||
    (planId !== undefined && item.planId !== planId) ||
    !phases.some((phase) => phase === item.phase) ||
    (item.state !== item.phase && item.state !== 'attention') ||
    item.portalUrl !== portalUrl ||
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    portalUrl.length > 531 ||
    [...portalUrl].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127) ||
    url.pathname !== '/sentinel/recovery/' ||
    url.search ||
    url.hash ||
    url.port === '0' ||
    !Number.isSafeInteger(item.expiresAtMs) ||
    (item.expiresAtMs as number) <= 0
  )
    throw new ControllerHandoffError();
  return item as ControllerHandoff;
}

async function request(action: 'plan' | 'apply', portalUrl: string, signal: AbortSignal, planId?: string) {
  if (action === 'apply' && (!planId || !identifier.test(planId))) throw new ControllerHandoffError();
  const response = await fetch(`/api/system/sentinel/controller-handoff/${action}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action === 'plan' ? {} : { planId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  });
  if (!response.ok) throw new ControllerHandoffError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new ControllerHandoffError();
  let bytes = 0;
  let text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        throw new ControllerHandoffError();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return parseControllerHandoff(JSON.parse(text), portalUrl, planId);
  } finally {
    reader.releaseLock();
  }
}

export async function reviewControllerHandoff(portalUrl: string, signal: AbortSignal, now?: number) {
  const plan = await request('plan', portalUrl, signal);
  const observedNow = now ?? Date.now();
  if (plan.state !== 'planned' || plan.phase !== 'planned' || plan.expiresAtMs <= observedNow || plan.expiresAtMs - observedNow > 300000)
    throw new ControllerHandoffError();
  return plan;
}

export function applyControllerHandoff(plan: ControllerHandoff, signal: AbortSignal) {
  return request('apply', plan.portalUrl, signal, plan.planId);
}

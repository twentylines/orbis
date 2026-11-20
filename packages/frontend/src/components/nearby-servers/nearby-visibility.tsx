import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type } from 'arktype';
import { Link } from 'react-router';
import { httpsSettingsPath, httpsSetupVisible } from '@/desktop/secure-access';
import { nearbyAdvertisingMessage, nearbyUnavailableCode, nearbyUnavailableMessage, type NearbyUnavailableCode } from './nearby-visibility-reason';
import { Button } from '@/components/ui/Button';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { AutosavedSettingSwitch } from '@/modules/settings/components/autosaved-setting-switch';
import { useAutosavedToggle } from '@/modules/settings/hooks/use-autosaved-toggle';
import { nearbyAddress, nearbyFallback, nearbyOrigin } from './nearby-api';
import './nearby-visibility.css';

const lease = type({ '+': 'reject', interface: 'string', origin: 'string', expiresAt: 'string' });
const addressLease = type({ '+': 'reject', kind: "'address'", interface: 'string', address: 'string', port: 'number', expiresAt: 'string' });
const status = type({
  '+': 'reject',
  available: 'true',
  policyVersion: '1',
  'hintVersion?': '2',
  enabled: 'boolean',
  sharing: lease.or(addressLease).or('null'),
});
export type NearbyVisibilityState = { available: false; sharing: null; reasonCode?: NearbyUnavailableCode } | typeof status.infer;
export async function readNearbyVisibility(signal?: AbortSignal): Promise<NearbyVisibilityState> {
  const response = await fetch('/api/nearby-discovery', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
  });
  if (response.status === 404) return { available: false, sharing: null, reasonCode: 'unsupported' };
  if (!response.ok) throw new Error(nearbyUnavailableMessage());
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(nearbyUnavailableMessage());
  }
  if (raw && typeof raw === 'object' && 'available' in raw && raw.available === false) {
    const reasonCode = nearbyUnavailableCode('reasonCode' in raw ? raw.reasonCode : undefined);
    return { available: false, sharing: null, ...(reasonCode ? { reasonCode } : {}) };
  }
  const value = status(raw);
  if (
    value instanceof type.errors ||
    (!value.enabled && value.sharing !== null) ||
    (value.sharing && (!/^[A-Za-z0-9_.-]{1,15}$/.test(value.sharing.interface) || !Number.isFinite(Date.parse(value.sharing.expiresAt))))
  )
    throw new Error(nearbyFallback);
  if (!value.sharing) return value;
  if ('kind' in value.sharing) {
    if (value.hintVersion !== 2 || !Number.isInteger(value.sharing.port) || value.sharing.port < 1 || value.sharing.port > 65535)
      throw new Error(nearbyFallback);
    return { ...value, sharing: { ...value.sharing, address: nearbyAddress(value.sharing.address) } };
  }
  return { ...value, sharing: { ...value.sharing, origin: nearbyOrigin(value.sharing.origin) } };
}
export async function setNearbyVisibility(enabled: boolean, signal?: AbortSignal) {
  const response = await fetch('/api/nearby-discovery/policy', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error('Nearby discovery could not be saved. Refresh its status before trying again.');
  const current = await readNearbyVisibility(signal);
  if (!current.available || current.enabled !== enabled || (enabled && !current.sharing))
    throw new Error('Nearby discovery could not be confirmed. Refresh its status before trying again.');
  return current;
}

const nearbyVisibilityKey = (userId: number) => ['nearby-discovery-policy', userId] as const;

export function useNearbyVisibilityToggle(enabled: boolean, disabled = false) {
  const { user } = useAppContext();
  const { sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const client = useQueryClient();
  const queryKey = nearbyVisibilityKey(user.id);
  const allowed = enabled && visible && user.operator === true && !disabled;
  const status = useQuery({
    queryKey,
    enabled: allowed,
    retry: false,
    queryFn: ({ signal }) => readNearbyVisibility(AbortSignal.any([signal, sessionAbortSignal])),
  });
  const state = status.data;
  const toggle = useAutosavedToggle({
    id: 'nearby-discovery',
    scope: 'nearby-discovery-policy',
    saved: state?.available ? state.enabled : false,
    disabled: !allowed || !state?.available,
    readError: status.isError ? status.error.message : undefined,
    save: async (checked, signal) => {
      const saved = await setNearbyVisibility(checked, signal);
      await client.cancelQueries({ queryKey, exact: true });
      signal.throwIfAborted();
      client.setQueryData(queryKey, saved);
    },
  });
  return { toggle, status, allowed };
}

export function NearbyVisibility({ disabled = false }: { disabled?: boolean }) {
  const { toggle, status, allowed } = useNearbyVisibilityToggle(true, disabled);
  const state = status.data;
  const client = useQueryClient();
  const { user } = useAppContext();
  useEffect(() => {
    if (!allowed || !state?.available || !state.sharing) return;
    const expiry = Date.parse(state.sharing.expiresAt);
    const timer = setTimeout(
      () =>
        client.setQueryData<NearbyVisibilityState>(nearbyVisibilityKey(user.id), (current) =>
          current === state ? { ...state, sharing: null } : current,
        ),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [allowed, client, state, user.id]);
  return (
    <div className="nearby-visibility">
      <AutosavedSettingSwitch label="Allow nearby discovery" toggle={{ ...toggle, disabled: toggle.disabled || toggle.pending }} showStatus />
      <p>When advertising, nearby Orbis servers can find this host’s private LAN address. Pairing and transfers still require HTTPS and approval.</p>
      <output aria-live="polite">
        {toggle.pending || toggle.error
          ? ''
          : state?.available
            ? nearbyAdvertisingMessage(state)
            : state
              ? nearbyUnavailableMessage(state.reasonCode)
              : status.isFetching
                ? 'Checking nearby discovery…'
                : 'Nearby discovery status has not been confirmed.'}
      </output>
      <div className="nearby-visibility-actions">
        <Button
          type="button"
          variant="outline"
          disabled={!allowed || toggle.pending || status.isFetching}
          onClick={() => {
            void status.refetch();
          }}
        >
          Refresh
        </Button>
        {typeof window !== 'undefined' && httpsSetupVisible(window.location.protocol) ? (
          <Button asChild variant="ghost">
            <Link to={httpsSettingsPath}>Set up HTTPS</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

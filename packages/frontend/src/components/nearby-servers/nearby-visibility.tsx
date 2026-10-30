import { useCallback, useEffect, useRef, useState } from 'react';
import { type } from 'arktype';
import { Link } from 'react-router';
import { httpsSettingsPath, httpsSetupVisible } from '@/desktop/secure-access';
import { nearbyAdvertisingMessage, nearbyUnavailableCode, nearbyUnavailableMessage, type NearbyUnavailableCode } from './nearby-visibility-reason';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { useWindowVisible } from '@/desktop/window-visibility';
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

export function NearbyVisibility({ disabled = false }: { disabled?: boolean }) {
  const visible = useWindowVisible();
  const [state, setState] = useState<NearbyVisibilityState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const current = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  const run = useCallback(
    async (enabled?: boolean) => {
      if (!visible || disabled || running.current) return;
      running.current = true;
      const version = ++generation.current;
      const operation = new AbortController();
      current.current?.abort();
      current.current = operation;
      setBusy(true);
      setMessage('');
      try {
        const result = enabled === undefined ? await readNearbyVisibility(operation.signal) : await setNearbyVisibility(enabled, operation.signal);
        if (generation.current === version && !operation.signal.aborted) setState(result);
      } catch (error) {
        if (generation.current === version && !operation.signal.aborted) {
          setState(null);
          setMessage(error instanceof Error ? error.message : nearbyFallback);
        }
      } finally {
        if (generation.current === version) {
          running.current = false;
          setBusy(false);
        }
      }
    },
    [visible, disabled],
  );
  useEffect(() => {
    if (visible && !disabled) void run();
    return () => {
      generation.current++;
      current.current?.abort();
      running.current = false;
    };
  }, [visible, disabled, run]);
  useEffect(() => {
    if (!visible || !state?.available || !state.sharing) return;
    const expiry = Date.parse(state.sharing.expiresAt);
    const timer = setTimeout(
      () => setState((current) => (current === state ? { ...state, sharing: null } : current)),
      Math.max(0, expiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [state, visible]);
  return (
    <div className="nearby-visibility">
      <Switch
        label="Allow nearby discovery"
        checked={state?.available ? state.enabled : false}
        disabled={disabled || busy || !visible || !state?.available}
        onCheckedChange={(enabled) => {
          void run(enabled);
        }}
      />
      <p>When advertising, nearby Orbis servers can find this host’s private LAN address. Pairing and transfers still require HTTPS and approval.</p>
      <output aria-live="polite">
        {message ||
          (state?.available
            ? nearbyAdvertisingMessage(state)
            : state
              ? nearbyUnavailableMessage(state.reasonCode)
              : busy
                ? 'Checking nearby discovery…'
                : 'Nearby discovery status has not been confirmed.')}
      </output>
      <div className="nearby-visibility-actions">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy || !visible}
          onClick={() => {
            void run();
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

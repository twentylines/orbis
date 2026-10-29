import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { type } from 'arktype';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import { Input } from '@/components/ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import { hideNearby, nearbyFallback, nearbyInterfaces, nearbyOrigin, showNearby, type NearbyInterface } from './nearby-api';
import './nearby-visibility.css';

const lease = type({ '+': 'reject', interface: 'string', origin: 'string', expiresAt: 'string' });
const status = type({ '+': 'reject', available: 'true', sharing: lease.or('null') });
export type NearbyVisibilityState = { available: false; sharing: null } | typeof status.infer;
export async function readNearbyVisibility(signal?: AbortSignal): Promise<NearbyVisibilityState> {
  const response = await fetch('/api/nearby-discovery', { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
  if (!response.ok) throw new Error(nearbyFallback);
  const raw: unknown = await response.json();
  if (raw && typeof raw === 'object' && 'available' in raw && raw.available === false) return { available: false, sharing: null };
  const value = status(raw);
  if (
    value instanceof type.errors ||
    (value.sharing && (!/^[A-Za-z0-9_.-]{1,15}$/.test(value.sharing.interface) || !Number.isFinite(Date.parse(value.sharing.expiresAt))))
  )
    throw new Error(nearbyFallback);
  return { ...value, sharing: value.sharing ? { ...value.sharing, origin: nearbyOrigin(value.sharing.origin) } : null };
}
export async function enableNearbyVisibility(selected: string, origin: string, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(selected)) throw new Error('Choose one private LAN interface.');
  const approvedOrigin = nearbyOrigin(origin);
  try {
    await showNearby(selected, approvedOrigin, signal);
    const result = await readNearbyVisibility(signal);
    if (!result.available || !result.sharing || result.sharing.interface !== selected || result.sharing.origin !== approvedOrigin) throw new Error();
    return result;
  } catch {
    throw new Error('Nearby visibility could not be confirmed. It may remain on for up to two minutes. Hide it or refresh status.');
  }
}
export async function disableNearbyVisibility(signal?: AbortSignal) {
  try {
    await hideNearby(signal);
    const result = await readNearbyVisibility(signal);
    if (!result.available || result.sharing !== null) throw new Error();
    return result;
  } catch {
    throw new Error('Nearby visibility could not be confirmed off. It expires automatically; refresh status to check.');
  }
}

export function NearbyVisibility({ disabled = false }: { disabled?: boolean }) {
  const id = useId();
  const visible = useWindowVisible();
  const [open, setOpen] = useState(false);
  const [interfaces, setInterfaces] = useState<NearbyInterface[]>([]);
  const [selected, setSelected] = useState('');
  const [origin, setOrigin] = useState('');
  const [state, setState] = useState<NearbyVisibilityState | null>(null);
  const [possible, setPossible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [consent, setConsent] = useState(false);
  const current = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!visible) current.current?.abort();
  }, [visible]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (running.current || disabled || !visible) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    const operation = new AbortController();
    current.current = operation;
    try {
      await work(operation.signal);
    } catch (error) {
      if (mounted.current && !operation.signal.aborted) setMessage(error instanceof Error ? error.message : nearbyFallback);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refresh = () =>
    run(async (signal) => {
      const [available, sharing] = await Promise.all([nearbyInterfaces(signal), readNearbyVisibility(signal)]);
      if (!mounted.current || signal.aborted) return;
      setInterfaces('interfaces' in available ? available.interfaces : []);
      setState(sharing);
      if (sharing.available) setPossible(Boolean(sharing.sharing));
      if (!available.available || !sharing.available) setMessage(nearbyFallback);
    });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (new FormData(form).get('nearby-consent') !== 'yes') return;
    setConsent(false);
    void run(async (signal) => {
      nearbyOrigin(origin);
      setPossible(true);
      const result = await enableNearbyVisibility(selected, origin, signal);
      if (mounted.current && !signal.aborted) {
        setState(result);
        setMessage('Nearby visibility confirmed for up to two minutes. Codes and approval are still required.');
      }
    });
  };
  return (
    <div className="nearby-visibility">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        aria-controls={`${id}-controls`}
        disabled={disabled || busy}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refresh();
        }}
      >
        Nearby visibility
      </Button>
      {open ? (
        <div id={`${id}-controls`} className="nearby-visibility-controls">
          <p>
            Let nearby Orbis servers on one selected LAN find this server’s HTTPS address for two minutes. This does not pair or approve a transfer.
          </p>
          {state?.sharing ? (
            <output>
              Visibility confirmed on {state.sharing.interface} until {new Date(state.sharing.expiresAt).toLocaleTimeString()}.
              <span className="nearby-visibility-origin">{state.sharing.origin}</span>
            </output>
          ) : state?.available && !possible ? (
            <output>Nearby visibility is off.</output>
          ) : null}
          {message ? <output aria-live="polite">{message}</output> : null}
          <form className="nearby-visibility-form" onSubmit={submit}>
            <div>
              <Select value={selected} onValueChange={setSelected} required disabled={disabled || busy || !interfaces.length}>
                <SelectTrigger id={`${id}-interface`} label="Private LAN interface">
                  <SelectValue placeholder="Choose an interface" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="" disabled>
                    Choose an interface
                  </SelectItem>
                  {interfaces.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.id} · {item.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Input
              id={`${id}-origin`}
              label="This server’s private HTTPS address"
              type="url"
              value={origin}
              required
              maxLength={240}
              placeholder="https://server.example"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled || busy}
              onChange={(event) => setOrigin(event.target.value)}
            />
            <Checkbox
              className="nearby-visibility-consent"
              id={`${id}-nearby-consent`}
              name="nearby-consent"
              value="yes"
              checked={consent}
              onCheckedChange={setConsent}
              required
              disabled={disabled || busy}
              label="Allow nearby computers on this interface to see this address for up to two minutes."
            />
            <div className="nearby-visibility-actions">
              <Button type="submit" intent="primary" disabled={disabled || busy || !visible || !selected || !origin || !interfaces.length}>
                Show for two minutes
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={disabled || busy || !visible}
                onClick={() => {
                  void refresh();
                }}
              >
                Refresh visibility
              </Button>
              {possible || state?.sharing ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || busy || !visible}
                  onClick={() => {
                    void run(async (signal) => {
                      const result = await disableNearbyVisibility(signal);
                      if (mounted.current && !signal.aborted) {
                        setState(result);
                        setPossible(false);
                        setMessage('Nearby visibility is off.');
                      }
                    });
                  }}
                >
                  Hide now
                </Button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

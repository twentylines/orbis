import { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import { nearbyFallback, nearbyInterfaces, scanNearby, type NearbyCandidate, type NearbyInterface } from './nearby-api';
import { NearbyRequestState } from './nearby-request-state';
import './nearby-servers.css';

export function NearbyServers({ onSelect }: { onSelect: (origin: string) => void }) {
  const visible = useWindowVisible();
  const [interfaces, setInterfaces] = useState<NearbyInterface[] | null>(null);
  const [selected, setSelected] = useState('');
  const [candidates, setCandidates] = useState<NearbyCandidate[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef<AbortController | null>(null);
  const selection = useRef(new NearbyRequestState());
  const resultInterface = useRef('');
  useEffect(() => {
    if (!visible) {
      current.current?.abort();
      setBusy(false);
    }
    return () => {
      current.current?.abort();
    };
  }, [visible]);
  const load = async (scan: boolean) => {
    if (busy || !visible) return;
    current.current?.abort();
    if (!scan) {
      selection.current.select('');
      setSelected('');
    }
    const operation = new AbortController();
    const request = selection.current.begin();
    current.current = operation;
    setBusy(true);
    setMessage('');
    setCandidates([]);
    try {
      const result = scan ? await scanNearby(request.interface, operation.signal) : await nearbyInterfaces(operation.signal);
      if (operation.signal.aborted || !selection.current.current(request)) return;
      if (!result.available) {
        setMessage(nearbyFallback);
        return;
      }
      if ('interfaces' in result) {
        setInterfaces(result.interfaces);
        if (!result.interfaces.length) setMessage('No private IPv4 LAN interface is available. Enter the address manually.');
      } else if ('candidates' in result) {
        resultInterface.current = request.interface;
        setCandidates(result.candidates);
        if (!result.candidates.length)
          setMessage('No nearby servers replied. Enter the address manually, or enable nearby visibility on the source.');
      }
    } catch {
      if (!operation.signal.aborted && selection.current.current(request)) setMessage(nearbyFallback);
    } finally {
      if (!operation.signal.aborted && selection.current.current(request)) setBusy(false);
    }
  };
  return (
    <div className="nearby-servers">
      <button type="button" className="btn btn-secondary" disabled={busy || !visible} onClick={() => void load(false)}>
        {busy ? 'Checking nearby servers…' : 'Find nearby servers'}
      </button>
      {interfaces?.length ? (
        <div className="nearby-servers-controls">
          <Select
            value={selected}
            onValueChange={(value) => {
              selection.current.select(value);
              current.current?.abort();
              setSelected(value);
              setCandidates([]);
              setMessage('');
              setBusy(false);
            }}
            disabled={busy}
          >
            <SelectTrigger label="Private LAN interface" className="nearby-interface-select">
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
          <button type="button" className="btn btn-secondary" disabled={busy || !selected || !visible} onClick={() => void load(true)}>
            Search this LAN
          </button>
        </div>
      ) : null}
      {message ? <output>{message}</output> : null}
      {candidates.length ? (
        <ul>
          {candidates.map((item) => (
            <li key={item.id}>
              <div>
                <strong>Orbis {item.id.slice(0, 6)}</strong>
                <span>{item.origin}</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (resultInterface.current !== selection.current.selectedInterface() || Date.parse(item.expiresAt) <= Date.now()) {
                    setCandidates([]);
                    setMessage('Nearby results expired. Search again, or enter the address manually.');
                  } else onSelect(item.origin);
                }}
              >
                Use address
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        Nearby results are unverified address hints. Pairing codes, HTTPS checks and approval are still required. You can always enter an address
        manually.
      </p>
    </div>
  );
}

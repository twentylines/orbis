import { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/Select';
import { useWindowVisible } from '@/desktop/window-visibility';
import { initialNearbySearch, NearbySearch } from './nearby-search';
import './nearby-servers.css';

export function NearbyServers({ onSelect }: { onSelect: (origin: string) => void }) {
  const visible = useWindowVisible();
  const [state, setState] = useState(initialNearbySearch);
  const search = useRef<NearbySearch | null>(null);
  if (!search.current) search.current = new NearbySearch(setState);
  const controller = search.current;
  const { interfaces, selected, candidates, message, busy } = state;
  useEffect(() => {
    if (visible) void controller.show();
    else {
      controller.hide();
      setState(controller.snapshot);
    }
    return () => controller.hide();
  }, [visible, controller]);
  return (
    <div className="nearby-servers">
      <div className="nearby-servers-controls">
        {interfaces && interfaces.length > 1 ? (
          <Select
            value={selected}
            onValueChange={(value) => {
              void controller.select(value);
            }}
            disabled={!visible}
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
        ) : null}
        <button type="button" className="btn btn-secondary" disabled={busy || !visible} onClick={() => void controller.refresh()}>
          Refresh
        </button>
      </div>
      <output aria-live="polite">{busy ? 'Searching…' : message}</output>
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
                disabled={busy || !visible}
                onClick={() => {
                  const origin = controller.choose(item.id);
                  if (origin) onSelect(origin);
                }}
              >
                Select
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p>Verify the selected server before pairing or restoring. You can also enter its address manually.</p>
    </div>
  );
}

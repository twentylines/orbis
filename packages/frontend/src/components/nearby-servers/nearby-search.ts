import { nearbyFallback, nearbyInterfaces, scanNearby, type NearbyCandidate, type NearbyInterface } from './nearby-api';

export type NearbySearchSnapshot = {
  interfaces: NearbyInterface[] | null;
  selected: string;
  candidates: NearbyCandidate[];
  message: string;
  busy: boolean;
};
export const initialNearbySearch: NearbySearchSnapshot = { interfaces: null, selected: '', candidates: [], message: '', busy: false };
type SearchApi = { interfaces: typeof nearbyInterfaces; scan: typeof scanNearby };

export class NearbySearch {
  snapshot = initialNearbySearch;
  private visible = false;
  private generation = 0;
  private operation?: AbortController;
  constructor(
    private readonly changed: (snapshot: NearbySearchSnapshot) => void,
    private readonly api: SearchApi = { interfaces: nearbyInterfaces, scan: scanNearby },
  ) {}
  private publish(patch: Partial<NearbySearchSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.changed(this.snapshot);
  }
  private begin() {
    this.operation?.abort();
    const controller = new AbortController();
    this.operation = controller;
    return { generation: ++this.generation, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) };
  }
  private current(request: { generation: number }) {
    return this.visible && request.generation === this.generation;
  }
  show() {
    if (this.visible) return Promise.resolve();
    this.visible = true;
    return this.inventory();
  }
  hide() {
    this.visible = false;
    this.generation++;
    this.operation?.abort();
    this.snapshot = { ...initialNearbySearch };
  }
  refresh() {
    if (!this.visible || this.snapshot.busy) return Promise.resolve();
    return this.inventory();
  }
  private async inventory() {
    const request = this.begin();
    this.publish({ ...initialNearbySearch, busy: true });
    try {
      const result = await this.api.interfaces(request.signal);
      if (!this.current(request)) return;
      if (request.signal.aborted || !result.available || !('interfaces' in result)) throw new Error();
      this.publish({ interfaces: result.interfaces });
      const single = result.interfaces.length === 1 ? result.interfaces[0] : undefined;
      if (single) await this.scan(single.id);
      else
        this.publish({
          message: result.interfaces.length
            ? 'Choose a private LAN interface to search.'
            : 'No private IPv4 LAN interface is available. Enter the address manually.',
        });
    } catch {
      if (this.current(request)) this.publish({ message: nearbyFallback });
    } finally {
      if (this.current(request)) this.publish({ busy: false });
    }
  }
  select(id: string) {
    if (!this.visible || !this.snapshot.interfaces?.some((item) => item.id === id) || this.snapshot.selected === id) return Promise.resolve();
    return this.scan(id);
  }
  private async scan(id: string) {
    const request = this.begin();
    this.publish({ selected: id, candidates: [], message: '', busy: true });
    try {
      const result = await this.api.scan(id, request.signal);
      if (!this.current(request)) return;
      if (request.signal.aborted || !result.available || !('candidates' in result)) throw new Error();
      this.publish({
        candidates: result.candidates,
        message: result.candidates.length ? '' : 'No nearby servers replied. Enter the address manually.',
      });
    } catch {
      if (this.current(request)) this.publish({ message: nearbyFallback });
    } finally {
      if (this.current(request)) this.publish({ busy: false });
    }
  }
  choose(id: string, now = Date.now()) {
    if (!this.visible || this.snapshot.busy) return;
    const candidate = this.snapshot.candidates.find((item) => item.id === id);
    if (!candidate) return;
    if (Date.parse(candidate.expiresAt) <= now) {
      this.publish({ candidates: [], message: 'Nearby results expired. Refresh, or enter the address manually.' });
      return;
    }
    return candidate.kind === 'address' ? undefined : candidate.origin;
  }
}

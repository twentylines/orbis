import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAppContext } from '@/context/app-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { Button } from '@/components/ui/Button';
import { SourceRequestReview } from './source-request-review';
import {
  readRestoreRequests,
  RestoreRequestApiError,
  type IncomingRestoreRequest,
  type OutgoingRestoreRequest,
  type RestoreRequests,
} from './receiver-request-api';

export const emptyRestoreRequests: RestoreRequests = { version: 1, incoming: [], outgoing: [] };
export function requestPollingAllowed(visible: boolean, operator: boolean, error: unknown) {
  return visible && operator && !(error instanceof RestoreRequestApiError && [401, 403, 404].includes(error.status));
}
export function pendingRestoreRequests(snapshot: RestoreRequests, now = Date.now()) {
  return snapshot.incoming.filter((value) => value.status === 'awaiting-approval' && value.expiresAt > now);
}
export function restoreRequestPresentation(data: RestoreRequests | undefined, operator: boolean, failed: boolean) {
  const snapshot = operator && !failed ? (data ?? emptyRestoreRequests) : emptyRestoreRequests;
  return { snapshot, pending: pendingRestoreRequests(snapshot) };
}
export class RestoreRequestNoticeState {
  private seen = new Set<string>();
  private advertised: string | undefined;
  get size() {
    return this.seen.size;
  }
  update(snapshot: RestoreRequests, available: boolean) {
    const current = new Set(snapshot.incoming.slice(-16).map((value) => value.id));
    this.seen = new Set([...this.seen].filter((id) => current.has(id)));
    const pending = available ? pendingRestoreRequests(snapshot) : [];
    const fresh = pending.filter((value) => !this.seen.has(value.id));
    for (const value of pending) this.seen.add(value.id);
    if (!pending.length) {
      this.advertised = undefined;
      return { dismiss: true, request: undefined };
    }
    const replacement = this.advertised && !pending.some((value) => value.id === this.advertised);
    const request = fresh[0] ?? (replacement ? pending[0] : undefined);
    if (request) this.advertised = request.id;
    return { dismiss: false, request };
  }
}
type RequestContext = {
  authority: object;
  snapshot: RestoreRequests;
  pendingCount: number;
  available: boolean;
  error: string | null;
  refresh: () => void;
  remember: (value: IncomingRestoreRequest | OutgoingRestoreRequest) => void;
  review: (id: string, opener: HTMLElement | null) => void;
};
export const RestoreRequestsContext = createContext<RequestContext | null>(null);
export const useRestoreRequests = () => useContext(RestoreRequestsContext);

export function ReceiverRequestProvider({ children }: { children: ReactNode }) {
  const { user, sessionIdentity, userSettings } = useAppContext();
  const instance = useId();
  const identity = [
    sessionIdentity,
    user?.id,
    user?.username,
    user?.operator,
    userSettings.domain,
    userSettings.localDomain,
    typeof window === 'undefined' ? '' : window.location.origin,
  ];
  const boundary = useRef({ identity, epoch: 0 });
  if (identity.some((value, index) => value !== boundary.current.identity[index])) boundary.current = { identity, epoch: boundary.current.epoch + 1 };
  return (
    <RequestSession
      key={`${instance}:${boundary.current.epoch}`}
      instance={`${instance}:${boundary.current.epoch}`}
      operator={user?.operator === true}
    >
      {children}
    </RequestSession>
  );
}
function RequestSession({ instance, operator, children }: { instance: string; operator: boolean; children: ReactNode }) {
  const visible = useWindowVisible();
  const client = useQueryClient();
  const queryKey = useMemo(() => ['restore-requests', instance], [instance]);
  const authority = useMemo(() => ({}), []);
  const mounted = useRef(true);
  const opener = useRef<HTMLElement | null>(null);
  const [reviewed, setReviewed] = useState<string | null>(null);
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => readRestoreRequests(signal),
    enabled: visible && operator,
    retry: false,
    staleTime: 4000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchInterval: (current) => (requestPollingAllowed(visible, operator, current.state.error) ? 5000 : false),
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void client.cancelQueries({ queryKey, exact: true });
      client.removeQueries({ queryKey, exact: true });
      toast.dismiss(`restore-request:${instance}`);
    };
  }, [client, queryKey, instance]);
  useEffect(() => {
    if (!visible || !operator) {
      setReviewed(null);
      void client.cancelQueries({ queryKey, exact: true });
    }
  }, [visible, operator, client, queryKey]);
  const { snapshot, pending } = restoreRequestPresentation(query.data, operator, query.isError);
  const noticeState = useRef(new RestoreRequestNoticeState());
  const reviewAction = useRef<(id: string, element: HTMLElement | null) => void>(() => undefined);
  reviewAction.current = (id, element) => {
    const current = client.getQueryState<RestoreRequests>(queryKey);
    const record = current?.data?.incoming.find((value) => value.id === id && value.status === 'awaiting-approval' && value.expiresAt > Date.now());
    if (!mounted.current || !visible || !operator || current?.status === 'error' || !record) {
      toast.dismiss(`restore-request:${instance}`);
      setReviewed(null);
      return;
    }
    opener.current = element;
    setReviewed(id);
  };
  useEffect(() => {
    const notice = noticeState.current.update(snapshot, visible && operator && !query.isError);
    if (notice.dismiss) {
      toast.dismiss(`restore-request:${instance}`);
      return;
    }
    const request = notice.request;
    if (!request) return;
    toast(
      (notice) => (
        <span className="receiver-request-notice">
          <span>A server is requesting an encrypted backup.</span>
          <Button
            type="button"
            variant="outline"
            onClick={(event) => {
              reviewAction.current(request.id, event.currentTarget);
              toast.dismiss(notice.id);
            }}
          >
            View request
          </Button>
        </span>
      ),
      { id: `restore-request:${instance}`, duration: Number.POSITIVE_INFINITY },
    );
  }, [visible, operator, query.isError, snapshot, instance]);
  useLayoutEffect(() => {
    if (query.isError) {
      setReviewed(null);
      toast.dismiss(`restore-request:${instance}`);
    }
  }, [query.isError, instance]);
  const unavailable = query.error instanceof RestoreRequestApiError && [401, 403, 404].includes(query.error.status);
  const value: RequestContext = {
    authority,
    snapshot,
    pendingCount: pending.length,
    available: operator && !query.isError,
    error: query.isError && !unavailable ? 'Restore requests could not be refreshed. Try again.' : null,
    refresh: () => {
      if (mounted.current && visible && operator && !unavailable) void query.refetch();
    },
    remember: (record) => {
      if (!mounted.current || !operator || client.getQueryState(queryKey)?.status === 'error') return;
      client.setQueryData<RestoreRequests>(queryKey, (previous) => {
        const data = previous ?? emptyRestoreRequests;
        return 'importId' in record
          ? { ...data, outgoing: [...data.outgoing.filter((entry) => entry.id !== record.id), record].slice(-16) }
          : { ...data, incoming: [...data.incoming.filter((entry) => entry.id !== record.id), record].slice(-16) };
      });
    },
    review: (id, element) => {
      reviewAction.current(id, element);
    },
  };
  return (
    <RestoreRequestsContext.Provider value={value}>
      {children}
      <SourceRequestReview
        request={visible && !query.isError ? snapshot.incoming.find((record) => record.id === reviewed) : undefined}
        authority={authority}
        disabled={!value.available || !visible}
        onUpdate={(record) => {
          value.remember(record);
          setReviewed(null);
        }}
        onClose={() => setReviewed(null)}
        restoreFocusTo={opener}
      />
    </RestoreRequestsContext.Provider>
  );
}

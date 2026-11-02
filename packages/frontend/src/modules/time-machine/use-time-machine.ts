import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppContext } from '@/context/app-context';
import { useUserContext } from '@/context/user-context';
import { useWindowVisible } from '@/desktop/window-visibility';
import { readTimeMachine, TimeMachineApiError } from './time-machine-api';
import { timeMachinePollDelay, type TimeMachineSnapshot } from './contracts';

export function useTimeMachine() {
  const { user } = useAppContext();
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const visible = useWindowVisible();
  const scope = useRef({ epoch: sessionEpoch, id: user.id, revision: 0 });
  if (scope.current.epoch !== sessionEpoch || scope.current.id !== user.id)
    scope.current = { epoch: sessionEpoch, id: user.id, revision: scope.current.revision + 1 };
  const identity = scope.current;
  const [state, setState] = useState<{ identity: typeof identity; snapshot: TimeMachineSnapshot | null; error: string; notice: string }>({
    identity,
    snapshot: null,
    error: '',
    notice: '',
  });
  const current = state.identity === identity ? state : { identity, snapshot: null, error: '', notice: '' };
  const [busyScope, setBusy] = useState<typeof identity | null>(null);
  const pending = useRef<typeof identity | null>(null);
  const generation = useRef(0);
  const lifetime = useRef<AbortController | null>(null);
  const verifiedLifetime = useRef<AbortController | null>(null);
  const reading = useRef<{ owner: AbortController | null; identity: typeof identity; promise: Promise<TimeMachineSnapshot> } | null>(null);
  const eligible = visible && user.operator === true && !sessionAbortSignal.aborted;
  const refresh = useCallback(
    (signal: AbortSignal) => {
      const previous = reading.current;
      const owner = lifetime.current;
      if (previous?.owner === owner && previous.identity === identity) return previous.promise;
      const attempt = ++generation.current;
      const promise = (async () => {
        await previous?.promise.catch(() => undefined);
        signal.throwIfAborted();
        const snapshot = await readTimeMachine(signal);
        if (!signal.aborted && scope.current === identity && attempt === generation.current) {
          verifiedLifetime.current = owner;
          setState((previous) => ({ identity, snapshot, error: '', notice: previous.identity === identity ? previous.notice : '' }));
        }
        return snapshot;
      })();
      const request = { owner, identity, promise };
      reading.current = request;
      const finished = () => {
        if (reading.current === request) reading.current = null;
      };
      void promise.then(finished, finished);
      return promise;
    },
    [identity],
  );
  useEffect(() => {
    if (!eligible) return;
    const controller = new AbortController();
    lifetime.current = controller;
    const signal = AbortSignal.any([controller.signal, sessionAbortSignal]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let snapshot: TimeMachineSnapshot | null = null;
      if (pending.current === identity) {
        timeout = setTimeout(() => void poll(), 1000);
        return;
      }
      try {
        snapshot = await refresh(signal);
      } catch (failure) {
        if (!signal.aborted && scope.current === identity)
          setState((previous) => ({
            identity,
            snapshot:
              failure instanceof TimeMachineApiError && [401, 403].includes(failure.status)
                ? null
                : previous.identity === identity
                  ? previous.snapshot
                  : null,
            error: failure instanceof Error ? failure.message : 'Time Machine could not be read.',
            notice: '',
          }));
      }
      if (!signal.aborted && scope.current === identity) timeout = setTimeout(() => void poll(), timeMachinePollDelay(snapshot, true) || 30_000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
      if (lifetime.current === controller) lifetime.current = null;
    };
  }, [eligible, identity, refresh, sessionAbortSignal]);
  const perform = async (action: (signal: AbortSignal) => Promise<unknown>, success: string) => {
    const controller = lifetime.current;
    if (!eligible || !controller || verifiedLifetime.current !== controller || current.error || pending.current === identity) return false;
    pending.current = identity;
    setBusy(identity);
    setState((previous) => ({ identity, snapshot: previous.identity === identity ? previous.snapshot : null, error: '', notice: '' }));
    const signal = AbortSignal.any([controller.signal, sessionAbortSignal]);
    try {
      await reading.current?.promise;
      signal.throwIfAborted();
      if (scope.current !== identity) return false;
      await action(signal);
      if (signal.aborted || scope.current !== identity) return false;
      setState((previous) => ({ ...previous, notice: success }));
      try {
        await refresh(signal);
      } catch {
        if (!signal.aborted && scope.current === identity)
          setState((previous) => ({
            ...previous,
            error: 'The request was accepted. Waiting for the next automatic status check before another action.',
          }));
      }
      return true;
    } catch (failure) {
      if (!signal.aborted && scope.current === identity)
        setState((previous) => ({
          ...previous,
          error: failure instanceof Error ? failure.message : 'The request could not be confirmed. Wait for the next status check before retrying.',
        }));
      return false;
    } finally {
      if (pending.current === identity) pending.current = null;
      if (scope.current === identity) setBusy(null);
    }
  };
  return {
    ...current,
    visible: eligible,
    busy: busyScope === identity,
    perform,
    canMutate: Boolean(eligible && lifetime.current && verifiedLifetime.current === lifetime.current && !current.error),
    retry: async () => {
      const controller = lifetime.current;
      if (!eligible || !controller || pending.current === identity) return false;
      const signal = AbortSignal.any([controller.signal, sessionAbortSignal]);
      try {
        await refresh(signal);
        return !signal.aborted;
      } catch (failure) {
        if (!signal.aborted && scope.current === identity)
          setState((previous) => ({ ...previous, error: failure instanceof Error ? failure.message : 'Time Machine could not be read.' }));
        return false;
      }
    },
    sessionAbortSignal,
    sessionEpoch,
    user,
  };
}

import { useCallback, useId, useLayoutEffect, useRef, useState } from 'react';
import { useUserContext } from '@/context/user-context';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { cacheThemePackSelection } from './use-theme-pack';
import { decodeThemePackCache, themePackCacheKey } from './theme-pack-cache';
import { selectThemePack, themePacksRequest } from './theme-packs-api';
import { clearThemeApplyHandoff, writeThemeApplyHandoff } from './theme-apply-handoff';
import { runThemeApply, sameTheme, type ThemeApplyAction, type ThemeApplyStage } from './theme-apply-state';
import { ThemeApplyCover } from './theme-apply-cover';
import type { ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';

let applying: object | null = null;
export function persistThemeApply(snapshot: ThemePackSnapshot) {
  cacheThemePackSelection(snapshot.state);
  try {
    const raw = localStorage.getItem(themePackCacheKey);
    const cached = decodeThemePackCache(raw);
    if (snapshot.state.selected ? !sameTheme(cached, snapshot.state.selected) : raw !== null) return false;
    return writeThemeApplyHandoff(snapshot.state.selected);
  } catch {
    return false;
  }
}

export function useThemeApply(fallbackFocusId?: string) {
  const { sessionEpoch, sessionAbortSignal } = useUserContext();
  const descriptionId = useId();
  const currentSession = useRef(sessionEpoch);
  currentSession.current = sessionEpoch;
  const [action, setAction] = useState<ThemeApplyAction | null>(null);
  const [phase, setPhase] = useState<'review' | ThemeApplyStage | 'error' | 'idle'>('idle');
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const attempt = useRef<{ controller: AbortController; owner: object; reloadTimer?: ReturnType<typeof setTimeout> } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const painted = useRef<(() => void) | null>(null);
  const running = useRef(false);
  const onPaint = useCallback(() => {
    painted.current?.();
    painted.current = null;
  }, []);
  const cancel = useCallback(() => {
    const active = attempt.current;
    active?.controller.abort();
    if (active?.reloadTimer) clearTimeout(active.reloadTimer);
    if (applying === active?.owner) applying = null;
    attempt.current = null;
    running.current = false;
    painted.current = null;
    clearThemeApplyHandoff();
    setAction(null);
    setPhase('idle');
    setError('');
    if (!sessionAbortSignal.aborted)
      requestAnimationFrame(() => {
        if (sessionAbortSignal.aborted) return;
        const target = opener.current?.isConnected ? opener.current : fallbackFocusId ? document.getElementById(fallbackFocusId) : null;
        target?.focus({ preventScroll: true });
      });
  }, [sessionAbortSignal, fallbackFocusId]);
  useLayoutEffect(() => {
    currentSession.current = sessionEpoch;
    const invalidated = () => {
      if (attempt.current) cancel();
    };
    sessionAbortSignal.addEventListener('abort', invalidated);
    setAction(null);
    setPhase('idle');
    setError('');
    return () => {
      sessionAbortSignal.removeEventListener('abort', invalidated);
      const active = attempt.current;
      active?.controller.abort();
      if (active?.reloadTimer) clearTimeout(active.reloadTimer);
      if (applying === active?.owner) applying = null;
      attempt.current = null;
      running.current = false;
      painted.current = null;
    };
  }, [sessionEpoch, sessionAbortSignal, cancel]);
  const apply = async () => {
    if (!action || running.current || (attempt.current && phase !== 'error')) return;
    const previous = attempt.current;
    previous?.controller.abort();
    if (previous?.reloadTimer) clearTimeout(previous.reloadTimer);
    const owner = previous?.owner ?? {};
    if (applying && applying !== owner) return;
    applying = owner;
    running.current = true;
    const controller = new AbortController();
    const active = { controller, owner } as NonNullable<typeof attempt.current>;
    attempt.current = active;
    const epoch = sessionEpoch;
    const signal = AbortSignal.any([sessionAbortSignal, controller.signal]);
    const current = () => !signal.aborted && currentSession.current === epoch && attempt.current === active;
    setError('');
    setPhase('checking');
    setGeneration((value) => value + 1);
    try {
      await runThemeApply(action, {
        signal,
        current,
        cover: () =>
          new Promise<void>((resolve, reject) => {
            painted.current = resolve;
            signal.addEventListener('abort', () => reject(new Error('Theme change cancelled.')), { once: true });
          }),
        read: () => themePacksRequest('', 'GET', undefined, signal),
        execute: () =>
          action.kind === 'select'
            ? selectThemePack(action.target, signal)
            : themePacksRequest(
                `/${action.id}${action.kind === 'remove' ? '' : `/${action.kind}`}`,
                action.kind === 'remove' ? 'DELETE' : 'POST',
                undefined,
                signal,
              ),
        persist: persistThemeApply,
        stage: (next) => {
          if (current()) setPhase(next);
        },
        reload: () => {
          if (!current()) return;
          window.location.reload();
          active.reloadTimer = setTimeout(() => {
            if (current()) {
              setError('The workspace did not reload. Retry or cancel.');
              running.current = false;
              setPhase('error');
            }
          }, 8000);
        },
      });
    } catch (failure) {
      if (current()) {
        running.current = false;
        setError(failure instanceof Error ? failure.message : 'Theme change failed. Retry or cancel.');
        setPhase('error');
      }
    }
  };
  const stage = (next: ThemeApplyAction) => {
    if (phase !== 'idle' || (next.kind === 'select' && sameTheme(next.source, next.target))) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAction({ ...next, source: next.source ? { ...next.source } : null, target: next.target ? { ...next.target } : null });
    setPhase('review');
  };
  const confirmation = (
    <>
      <Dialog
        open={phase === 'review'}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
      >
        <DialogContent size="md" aria-describedby={descriptionId}>
          <DialogHeader>
            <DialogTitle>{action?.kind === 'remove' ? 'Remove theme and apply Default?' : `Apply ${action?.name ?? 'theme'}?`}</DialogTitle>
          </DialogHeader>
          <DialogDescription id={descriptionId}>
            {action?.kind === 'remove' ? 'This removes the selected theme and applies Default. ' : ''}The workspace will reload. Save other changes
            first; unsaved changes will be lost.
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={cancel}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void apply()}>
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {phase !== 'idle' && phase !== 'review' ? (
        <ThemeApplyCover
          label="Applying theme…"
          error={phase === 'error' ? error : undefined}
          generation={generation}
          onPaint={onPaint}
          onRetry={() => void apply()}
          onCancel={cancel}
        />
      ) : null}
    </>
  );
  return { busy: phase !== 'idle', stage, confirmation };
}

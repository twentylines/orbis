import { create } from 'zustand';
import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

type Confirmation = { message: string; resolve: (accepted: boolean) => void };
const useConfirmation = create<{ pending: Confirmation | null }>(() => ({ pending: null }));

export function confirmDiscard(message: string): Promise<boolean> {
  if (useConfirmation.getState().pending) return Promise.resolve(false);
  return new Promise((resolve) => useConfirmation.setState({ pending: { message, resolve } }));
}

export function resolveConfirmation(accepted: boolean) {
  const pending = useConfirmation.getState().pending;
  useConfirmation.setState({ pending: null });
  pending?.resolve(accepted);
}

export function ConfirmationDialog() {
  const pending = useConfirmation((state) => state.pending);
  const { pathname } = useLocation();
  // biome-ignore lint/correctness/useExhaustiveDependencies: Navigating away must cancel the pending editor action.
  useEffect(() => () => resolveConfirmation(false), [pathname]);
  return (
    <Dialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open) resolveConfirmation(false);
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
        </DialogHeader>
        <DialogDescription>{pending?.message}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => resolveConfirmation(false)}>
            Keep editing
          </Button>
          <Button intent="danger" onClick={() => resolveConfirmation(true)}>
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

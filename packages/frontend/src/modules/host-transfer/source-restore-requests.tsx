import { Button } from '@/components/ui/Button';
import { RecoveryProgress } from '@/components/recovery-progress/recovery-progress';
import { useRestoreRequests } from './receiver-request-context';
import { restoreRequestStopped, restoreExportStage, cancelSourceRestoreRequest } from './receiver-request-api';
import { useRef, useState, useLayoutEffect } from 'react';

export function SourceRestoreRequests() {
  const requests = useRestoreRequests();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Authority changes must revoke pending work and clear credentials.
  useLayoutEffect(() => {
    generation.current++;
    setError(null);
    setBusy(null);
    return () => {
      generation.current++;
    };
  }, [requests?.authority]);
  const records = requests?.snapshot.incoming.filter((value) => !restoreRequestStopped.has(value.status) && value.expiresAt > Date.now()) ?? [];
  if (!requests || !records.length) return null;
  return (
    <section className="receiver-request-card" aria-label="Incoming restore requests">
      <h3>Restore requests</h3>
      <ul className="receiver-request-list">
        {records.map((value) => (
          <li key={value.id}>
            <strong>
              {value.status === 'awaiting-approval'
                ? 'A destination is waiting for approval'
                : value.status === 'exporting'
                  ? 'Creating encrypted backup'
                  : value.status === 'sending'
                    ? 'Sending encrypted backup'
                    : 'Backup approved'}
            </strong>
            <small>
              Destination {value.destinationFingerprint.slice(0, 12)} · Expires {new Date(value.expiresAt).toLocaleTimeString()}
            </small>
            {value.exportProgress ? (
              <RecoveryProgress
                label={restoreExportStage(value.exportProgress.stage)}
                completed={value.exportProgress.completedBytes}
                total={value.exportProgress.totalBytes}
              />
            ) : null}
            {value.status === 'sending' ? (
              <RecoveryProgress label="Sending encrypted backup" completed={value.completedBytes} total={value.totalBytes} />
            ) : null}
            {value.status === 'awaiting-approval' ? (
              <Button
                type="button"
                variant="outline"
                disabled={!requests.available}
                onClick={(event) => requests.review(value.id, event.currentTarget)}
              >
                View request
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  const token = generation.current;
                  setBusy(value.id);
                  setError(null);
                  void cancelSourceRestoreRequest(value.id)
                    .then((record) => {
                      if (generation.current === token) requests.remember(record);
                    })
                    .catch(() => {
                      if (generation.current === token) setError('The backup could not be cancelled. Refresh its status before retrying.');
                    })
                    .finally(() => {
                      if (generation.current === token) setBusy(null);
                    });
                }}
              >
                {busy === value.id ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

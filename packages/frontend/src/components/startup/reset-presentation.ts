import { operationIsWaiting, type OperationSnapshot } from '@/components/recovery-progress/operation-status';

export function resetLoadingPresentation(snapshot: OperationSnapshot | null) {
  const recovery = snapshot?.state === 'recovery' || snapshot?.stage === 'recovering';
  if (!snapshot || operationIsWaiting(snapshot))
    return {
      title: 'Resetting preferences',
      stage: 'Waiting for the server',
      message: snapshot?.unavailable
        ? 'The connection was interrupted. Waiting for the server to respond.'
        : 'Waiting for the server to respond. Your applications and data are kept.',
      recovery: false,
    };
  if (recovery)
    return {
      title: 'Reset needs attention',
      stage: 'Waiting for confirmation',
      message: 'Confirm the reset again to continue. Your applications and data stay in place.',
      recovery: true,
    };
  const stages = {
    preparing: 'Preparing reset',
    downloading: 'Downloading files',
    applying: 'Applying reset',
    restarting: 'Restarting Orbis',
    verifying: 'Verifying reset',
    restoring: 'Restoring server state',
    resetting: 'Resetting preferences',
    recovering: 'Waiting for confirmation',
  } as const;
  return {
    title: 'Resetting preferences',
    stage: snapshot.state === 'resetting' ? stages[snapshot.stage ?? 'resetting'] : 'Checking reset',
    message: 'Your applications and data are kept. Setup opens when the reset is complete.',
    recovery: false,
  };
}

let diagnostic: ((error: unknown) => { event: string; phase: string; code: string }) | undefined;
try {
  const worker = await import('./modules/system-backups/time-machine-core-live-reconciliation-worker');
  diagnostic = worker.coreLiveReconciliationFailureDiagnostic;
  if (process.argv.length === 3 && process.argv[2] === '--capability')
    process.stdout.write(JSON.stringify(worker.coreLiveReconciliationWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--reconcile-live' && process.platform === 'linux' && process.getuid?.() === 0) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      await worker.reconcileCoreLiveDatabaseWorker({
        input: worker.coreLiveReconciliationWorkerCapability.input,
        output: worker.coreLiveReconciliationWorkerCapability.output,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(worker.coreLiveReconciliationWorkerCapability.deadlineMs)]),
      });
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
    }
  } else throw new Error('Unsupported live reconciliation action');
} catch (error) {
  process.stderr.write(`${JSON.stringify(diagnostic?.(error) ?? { event: 'core-live-reconciliation-failed', phase: 'input', code: 'unknown' })}\n`);
  process.exitCode = 1;
}

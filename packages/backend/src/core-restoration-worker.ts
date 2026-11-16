let diagnostic: ((error: unknown) => { event: string; phase: string; code: string }) | undefined;
try {
  const worker = await import('./modules/system-backups/time-machine-core-restoration-worker');
  diagnostic = worker.coreRestorationFailureDiagnostic;
  if (process.argv.length === 3 && process.argv[2] === '--capability') process.stdout.write(JSON.stringify(worker.coreRestorationWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--live-capability')
    process.stdout.write(JSON.stringify(worker.coreLiveRestorationWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--verify-imported' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.verifyCoreRestorationWorker({
      input: worker.coreRestorationWorkerCapability.input,
      output: worker.coreRestorationWorkerCapability.output,
      signal: AbortSignal.timeout(worker.coreRestorationWorkerCapability.deadlineMs),
    });
  else if (process.argv.length === 3 && process.argv[2] === '--verify-live-imported' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.verifyCoreLiveRestorationWorker({
      input: worker.coreLiveRestorationWorkerCapability.input,
      output: worker.coreLiveRestorationWorkerCapability.output,
      signal: AbortSignal.timeout(worker.coreLiveRestorationWorkerCapability.deadlineMs),
    });
  else throw new Error('Unsupported core restoration action');
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(diagnostic?.(error) ?? { event: 'core-restoration-verification-failed', phase: 'input', code: 'unknown' })}\n`,
  );
  process.exitCode = 1;
}

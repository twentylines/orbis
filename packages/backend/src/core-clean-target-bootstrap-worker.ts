let diagnostic: ((error: unknown) => { event: string; phase: string; code: string }) | undefined;
try {
  const worker = await import('./modules/system-backups/time-machine-core-clean-target-bootstrap-worker');
  diagnostic = worker.coreCleanTargetBootstrapFailureDiagnostic;
  if (process.argv.length === 3 && process.argv[2] === '--capability')
    process.stdout.write(JSON.stringify(worker.coreCleanTargetBootstrapWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--capability-v2')
    process.stdout.write(JSON.stringify(worker.coreCleanTargetBootstrapWorkerCapabilityV2));
  else if (process.argv.length === 3 && process.argv[2] === '--bootstrap' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.bootstrapCoreCleanTarget({
      input: worker.coreCleanTargetBootstrapWorkerCapability.input,
      output: worker.coreCleanTargetBootstrapWorkerCapability.output,
      migrations: worker.coreCleanTargetBootstrapWorkerCapability.migrations,
      signal: AbortSignal.timeout(worker.coreCleanTargetBootstrapWorkerCapability.deadlineMs),
    });
  else throw new Error('Unsupported clean target bootstrap action');
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(diagnostic?.(error) ?? { event: 'core-clean-target-bootstrap-failed', phase: 'input', code: 'unknown' })}\n`,
  );
  process.exitCode = 1;
}

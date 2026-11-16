let diagnostic: ((error: unknown) => { event: string; phase: string; code: string }) | undefined;
try {
  const worker = await import('./modules/system-backups/time-machine-core-clean-target-worker');
  diagnostic = worker.coreCleanTargetFailureDiagnostic;
  if (process.argv.length === 3 && process.argv[2] === '--capability') process.stdout.write(JSON.stringify(worker.coreCleanTargetWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--capability-v2')
    process.stdout.write(JSON.stringify(worker.coreCleanTargetWorkerCapabilityV2));
  else if (process.argv.length === 3 && process.argv[2] === '--verify-capability-v2')
    process.stdout.write(JSON.stringify(worker.coreCleanTargetVerifyCapabilityV2));
  else if (process.argv.length === 3 && process.argv[2] === '--verify-v2' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.verifyCoreCleanTargetWorker({
      input: worker.coreCleanTargetVerifyCapabilityV2.input,
      output: worker.coreCleanTargetVerifyCapabilityV2.output,
      signal: AbortSignal.timeout(worker.coreCleanTargetVerifyCapabilityV2.deadlineMs),
    });
  else if (process.argv.length === 3 && process.argv[2] === '--prepare' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.prepareCoreCleanTargetWorker({
      input: worker.coreCleanTargetWorkerCapability.input,
      output: worker.coreCleanTargetWorkerCapability.output,
      signal: AbortSignal.timeout(worker.coreCleanTargetWorkerCapability.deadlineMs),
    });
  else throw new Error('Unsupported clean target action');
} catch (error) {
  process.stderr.write(`${JSON.stringify(diagnostic?.(error) ?? { event: 'core-clean-target-failed', phase: 'input', code: 'unknown' })}\n`);
  process.exitCode = 1;
}

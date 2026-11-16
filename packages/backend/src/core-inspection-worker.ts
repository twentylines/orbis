let diagnostic: ((error: unknown) => { event: string; phase: string; code: string }) | undefined;
try {
  const worker = await import('./modules/system-backups/time-machine-core-inspection-worker');
  diagnostic = worker.coreInspectionFailureDiagnostic;
  if (process.argv.length === 3 && process.argv[2] === '--capability') process.stdout.write(JSON.stringify(worker.coreInspectionWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--capability-role-bound')
    process.stdout.write(JSON.stringify(worker.roleBoundCoreInspectionWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--capability-bootstrap-source')
    process.stdout.write(JSON.stringify(worker.bootstrapSourceCoreInspectionWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--capability-versioned-bootstrap-source')
    process.stdout.write(JSON.stringify(worker.versionedBootstrapSourceCoreInspectionWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--inspect' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.inspectCoreSource({ input: '/inspection-input', output: '/inspection-output', signal: AbortSignal.timeout(120000) });
  else throw new Error('Unsupported inspection action');
} catch (error) {
  process.stderr.write(`${JSON.stringify(diagnostic?.(error) ?? { event: 'core-inspection-failed', phase: 'input', code: 'unknown' })}\n`);
  process.exitCode = 1;
}

try {
  const worker = await import('./modules/system-backups/time-machine-core-source-configuration-worker');
  if (process.argv.length === 3 && process.argv[2] === '--capability')
    process.stdout.write(JSON.stringify(worker.coreSourceConfigurationWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--target-capability')
    process.stdout.write(JSON.stringify(worker.coreTargetConfigurationWorkerCapability));
  else if (process.argv.length === 3 && process.argv[2] === '--live-authentication-capability')
    process.stdout.write(JSON.stringify(worker.coreLiveAuthenticationWorkerCapability));
  else if (
    process.argv.length === 3 &&
    process.argv[2] === '--project-live-authentication' &&
    process.platform === 'linux' &&
    process.getuid?.() === 0
  )
    await worker.prepareCoreLiveAuthentication({
      input: '/source-configuration-input',
      output: '/source-configuration-output',
      signal: AbortSignal.timeout(30000),
    });
  else if (process.argv.length === 3 && process.argv[2] === '--project-target' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.prepareCoreTargetConfiguration({
      input: '/source-configuration-input',
      output: '/source-configuration-output',
      signal: AbortSignal.timeout(30000),
    });
  else if (process.argv.length === 3 && process.argv[2] === '--project' && process.platform === 'linux' && process.getuid?.() === 0)
    await worker.prepareCoreSourceConfiguration({
      input: '/source-configuration-input',
      output: '/source-configuration-output',
      signal: AbortSignal.timeout(30000),
    });
  else throw new Error('Unsupported source preparation action');
} catch {
  process.stderr.write('{"event":"core-source-configuration-failed"}\n');
  process.exitCode = 1;
}

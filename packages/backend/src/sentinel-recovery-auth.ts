import {
  recoveryAuthenticationArguments,
  recoveryAuthenticationCapability,
  runRecoveryAuthenticationWorker,
} from './modules/sentinel-recovery/worker';

let timer: ReturnType<typeof setTimeout> | undefined;
try {
  if (recoveryAuthenticationArguments(process.argv.slice(2)).mode === 'verify') {
    timer = setTimeout(() => {
      process.stderr.write('Recovery authentication could not be completed.\n');
      process.exit(1);
    }, recoveryAuthenticationCapability.deadlineMs);
  }
  const result = await runRecoveryAuthenticationWorker(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.stderr.write('Recovery authentication could not be completed.\n');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}

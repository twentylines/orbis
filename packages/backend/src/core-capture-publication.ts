import { runCorePublicationWorker } from './modules/system-backups/time-machine-core-publication-worker';

runCorePublicationWorker(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch(() => {
    process.stderr.write('Capture verification failed.\n');
    process.exitCode = 1;
  });

import { runCorePortableWorker } from './modules/system-backups/time-machine-core-portable-worker';

runCorePortableWorker(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch(() => {
    process.stderr.write('Portable core verification failed.\n');
    process.exitCode = 1;
  });

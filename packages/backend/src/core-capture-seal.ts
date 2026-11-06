import { runCoreSealWorker } from './modules/system-backups/time-machine-core-seal-worker';

runCoreSealWorker(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch(() => {
    process.stderr.write('Capture sealing failed.\n');
    process.exitCode = 1;
  });

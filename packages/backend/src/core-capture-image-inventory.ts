import { runCoreImageInventoryWorker } from './modules/system-backups/time-machine-core-image-inventory-worker';

runCoreImageInventoryWorker(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch(() => {
    process.stderr.write('Image inventory failed.\n');
    process.exitCode = 1;
  });

import { runCoreCatalogWorker } from './modules/system-backups/time-machine-core-catalog-worker';

runCoreCatalogWorker(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(JSON.stringify(result));
  })
  .catch(() => {
    process.stderr.write(JSON.stringify({ error: 'Catalog verification failed.' }));
    process.exitCode = 1;
  });

import { verifyComponentsCatalog, observeComponentsCatalog } from './modules/system-backups/time-machine-components-catalog';

const args = process.argv.slice(2);
if (args.length !== 2 || !['--verify', '--observe'].includes(args[0] ?? '') || !args[1]) process.exitCode = 1;
else
  (args[0] === '--observe' ? observeComponentsCatalog('/data', args[1]) : verifyComponentsCatalog('/data', args[1], AbortSignal.timeout(110_000)))
    .then((value) => process.stdout.write(JSON.stringify(value)))
    .catch(() => {
      process.stderr.write('Components catalog verification is unavailable.');
      process.exitCode = 1;
    });

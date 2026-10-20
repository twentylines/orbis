import fs from 'node:fs';
import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import type { LoggerService } from '@/core/logger/logger.service';
import { RestoreTransaction } from '../restore-transaction';

const [root, boundary] = process.argv.slice(2);
if (!root || !boundary || !root.startsWith('/tmp/orbis-restore-transaction-')) throw new Error('Invalid isolated crash fixture');
const groups = ['app-data', 'app', 'user-config'] as const;
const locations = Object.fromEntries(groups.map((name) => [name, path.join(root, 'live', name, 'store', 'demo')])) as Record<
  (typeof groups)[number],
  string
>;
const sources = Object.fromEntries(groups.map((name) => [name, path.join(root, 'source', name)])) as typeof locations;
const logger = { info: () => undefined, debug: () => undefined, error: () => undefined, warn: () => undefined } as unknown as LoggerService;
const stopAtCheckpoint = async () => {
  process.stdout.write('CHECKPOINT\n');
  await new Promise(() => setInterval(() => undefined, 1000));
};
const rename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async (source, destination) => {
  await rename(source, destination);
  for (const name of groups) {
    if ((boundary === `old-${name}` && String(source) === locations[name]) || (boundary === `new-${name}` && String(destination) === locations[name]))
      await stopAtCheckpoint();
  }
};
const remove = fs.promises.rm.bind(fs.promises);
fs.promises.rm = async (file, options) => {
  const journalPath = path.join(root, 'data', 'state', 'app-restores', 'demo:store', 'journal.json');
  if (boundary === 'committed' && String(file).endsWith('.tmp')) {
    const journal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8')) as { phase: string };
    if (journal.phase === 'committed') await stopAtCheckpoint();
  }
  await remove(file, options);
  if (boundary === 'cleanup' && path.basename(String(file)).includes('.orbis-restore-')) await stopAtCheckpoint();
};
const transaction = new RestoreTransaction(
  new FilesystemService(logger),
  logger,
  () => path.join(root, 'data', 'state', 'app-restores'),
  () => locations,
);
await transaction.replace(
  createAppUrn('demo', 'store'),
  boundary === 'extracting'
    ? async (directory) => {
        await fs.promises.writeFile(path.join(directory, 'partial'), 'unfinished extraction');
        await stopAtCheckpoint();
        return sources;
      }
    : sources,
);
throw new Error('Crash boundary was not reached');

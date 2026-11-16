import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { TimeMachineComponentsStore } from './time-machine-components-store';
import { decryptBackup } from './backup-crypto';
import { verifySelectedComponent } from './time-machine-selected-component';

const fail = () => new Error('Components catalog verification is unavailable.');
export async function verifyComponentsCatalog(dataDir: string, corePointId: string, signal: AbortSignal) {
  if (!timeMachineIdSchema.allows(corePointId)) throw fail();
  const store = new TimeMachineComponentsStore(dataDir);
  const points = (await store.list()).filter((point) => point.corePointId === corePointId);
  if (points.length !== 1) throw fail();
  const point = points[0];
  if (!point || point.status !== 'sealed' || !point.metadataSha256) throw fail();
  const value = await store.entries(point, signal);
  const directory = store.directory(point.id);
  const stage = await fs.mkdtemp(path.join(directory, 'catalog-'));
  await fs.chmod(stage, 0o700);
  const before = await fs.lstat(stage);
  const cleanup = async () => {
    const after = await fs.lstat(stage);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== before.uid ||
      after.mode !== before.mode
    )
      throw fail();
    for (const name of await fs.readdir(stage)) {
      if (!['apps.tar'].includes(name)) throw fail();
      const file = path.join(stage, name);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw fail();
      await fs.unlink(file);
    }
    await fs.rmdir(stage);
  };
  try {
    const plain = path.join(stage, 'apps.tar');
    await decryptBackup({ source: path.join(directory, 'apps.orbis'), destination: plain, passphrase: value.pointKey, signal });
    await verifySelectedComponent({ file: plain, receipt: value.metadata.selectedComponent.receipt, staging: stage, signal });
    if (JSON.stringify(await store.load(point.id)) !== JSON.stringify(point)) throw fail();
    return {
      schema: 'orbis.components-capture-catalog.v1',
      version: 1,
      pointId: point.id,
      corePointId,
      metadataSha256: point.metadataSha256,
      planSha256: point.planSha256,
      selectedReceiptSha256: value.metadata.selectedComponent.receiptSha256,
      coreCheckpointSha256: value.metadata.coreComponent.core.checkpointSha256,
      complete: true,
    } as const;
  } finally {
    await cleanup();
  }
}
export async function observeComponentsCatalog(dataDir: string, corePointId: string) {
  if (!timeMachineIdSchema.allows(corePointId)) throw fail();
  const store = new TimeMachineComponentsStore(dataDir);
  const points = (await store.list()).filter((point) => point.corePointId === corePointId);
  if (points.length !== 1) throw fail();
  const point = points[0];
  if (!point || point.status !== 'sealed' || !point.metadataSha256) throw fail();
  const metadata = await store.observe(point);
  return {
    schema: 'orbis.components-capture-catalog.v1',
    version: 1,
    pointId: point.id,
    corePointId,
    metadataSha256: point.metadataSha256,
    planSha256: point.planSha256,
    selectedReceiptSha256: metadata.selectedComponent.receiptSha256,
    coreCheckpointSha256: metadata.coreComponent.core.checkpointSha256,
    complete: true,
  } as const;
}

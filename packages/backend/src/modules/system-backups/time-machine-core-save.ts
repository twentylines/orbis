import type { CoreCheckpointDownload, HostCoreCaptureReader } from '../host-updates/host-core-capture-reader';
import { captureRetainedImages, type RetainedImageDocker } from './backup-image-retention';
import { prepareCorePayload } from './time-machine-core-payload';
import type { StoredCoreTimeMachinePoint, TimeMachineCoreDraftMetadata, TimeMachineStore } from './time-machine-store';

/** Internal publication step; lifecycle settlement and plaintext retention remain with the caller. */
export async function saveCoreCapture(options: {
  reader: HostCoreCaptureReader;
  download: CoreCheckpointDownload;
  checkpointDirectory: string;
  imageDirectory: string;
  docker: RetainedImageDocker;
  store: TimeMachineStore;
  point: StoredCoreTimeMachinePoint;
  metadata: TimeMachineCoreDraftMetadata;
  signal: AbortSignal;
  onCheckpointProgress?: (completed: number, total: number) => void;
}) {
  const { point, metadata, signal } = options;
  signal.throwIfAborted();
  if (point.version !== 3 || point.status !== 'capturing' || metadata.id !== point.id || metadata.createdAt !== point.createdAt)
    throw new Error('The core capture reservation changed.');
  const checkpoint = await options.reader.download(options.download, options.checkpointDirectory, signal, options.onCheckpointProgress);
  if (checkpoint.expectation.pointId !== point.id) throw new Error('The downloaded checkpoint belongs to another capture.');
  const saved = await captureRetainedImages({
    stagingDirectory: options.imageDirectory,
    docker: options.docker,
    signal,
    platform: { os: checkpoint.expectation.compatibility.os, architecture: checkpoint.expectation.compatibility.architecture },
    bindings: Object.entries(checkpoint.expectation.images).map(([key, imageId]) => ({ key, imageId })),
  });
  const payload = await prepareCorePayload({
    expectation: checkpoint.expectation,
    checkpointFile: checkpoint.checkpointFile,
    imageInventory: saved.inventory,
    imageDirectory: saved.directory,
    signal,
  });
  const sealed = await options.store.sealCore(point, payload, metadata, signal);
  // Keep private staging addresses out of web responses. An ambiguous seal must
  // retain evidence until the independent supervisor settles the operation.
  return { metadata: sealed, staging: { checkpointFile: checkpoint.checkpointFile, imageDirectory: saved.directory } };
}

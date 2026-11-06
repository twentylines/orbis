import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RetainedImageInventory } from './backup-image-retention';
import type { CorePayloadExpectation } from './time-machine-core-payload';

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function corePayloadTar(entries: { name: string; data: Buffer }[]) {
  const pieces: Buffer[] = [];
  for (const { name, data } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000600\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
      'ascii',
    );
    pieces.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...pieces, Buffer.alloc(1024)]);
}
export function corePayloadImage(kind: 'docker' | 'oci' = 'docker', architecture = 'arm64', content = 'authenticated fixture') {
  const layer = corePayloadTar([{ name: 'fixture', data: Buffer.from(content) }]);
  const config = Buffer.from(JSON.stringify({ architecture, os: 'linux', rootfs: { type: 'layers', diff_ids: [`sha256:${sha(layer)}`] } }));
  const configId = `sha256:${sha(config)}`;
  const blob = (id: string) => `blobs/sha256/${id.slice(7)}`;
  const configName = kind === 'oci' ? blob(configId) : `${configId.slice(7)}.json`;
  const layerName = kind === 'oci' ? blob(`sha256:${sha(layer)}`) : `${'b'.repeat(64)}/layer.tar`;
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configId, size: config.length },
      layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: `sha256:${sha(layer)}`, size: layer.length }],
    }),
  );
  const manifestId = `sha256:${sha(manifest)}`;
  const platform = { os: 'linux', architecture };
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestId, size: manifest.length, platform }],
    }),
  );
  const id = kind === 'docker' ? configId : `sha256:${'e'.repeat(64)}`;
  const archive = corePayloadTar([
    { name: configName, data: config },
    { name: layerName, data: layer },
    { name: 'manifest.json', data: Buffer.from(JSON.stringify([{ Config: configName, RepoTags: null, Layers: [layerName] }])) },
    ...(kind === 'oci'
      ? [
          { name: blob(manifestId), data: manifest },
          { name: 'index.json', data: index },
          { name: 'oci-layout', data: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
        ]
      : []),
  ]);
  return {
    archive,
    item: {
      imageId: id,
      repoDigests: [],
      archive: `image-${id.slice(7)}.tar`,
      bytes: archive.length,
      sha256: sha(archive),
      identity: {
        kind,
        configId,
        manifestId: kind === 'oci' ? manifestId : null,
        archiveRootId: kind === 'oci' ? `sha256:${sha(index)}` : id,
        platform: kind === 'oci' ? platform : null,
        expandedBytes: layer.length,
      },
    },
  };
}
export async function createCorePayloadFixture(kind: 'docker' | 'oci' = 'docker') {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'orbis-core-payload-'));
  await fs.chmod(root, 0o700);
  const imageDirectory = path.join(root, 'images');
  await fs.mkdir(imageDirectory, { mode: 0o700 });
  const checkpoint = corePayloadTar([{ name: 'database/PG_VERSION', data: Buffer.from('17\n') }]);
  const checkpointFile = path.join(root, 'checkpoint.tar');
  await fs.writeFile(checkpointFile, checkpoint, { mode: 0o600 });
  const saved = corePayloadImage(kind);
  await fs.writeFile(path.join(imageDirectory, saved.item.archive), saved.archive, { mode: 0o600 });
  const imageInventory: RetainedImageInventory = {
    version: 1,
    images: [saved.item],
    bindings: ['queue', 'database', 'controller'].map((key) => ({ key, imageId: saved.item.imageId })),
  };
  const expectation: CorePayloadExpectation = {
    pointId: '11111111-1111-4111-8111-111111111111',
    sourceSha256: 'a'.repeat(64),
    checkpointSha256: 'b'.repeat(64),
    captureReceiptSha256: 'c'.repeat(64),
    resourceCount: 4,
    images: { controller: saved.item.imageId, database: saved.item.imageId, queue: saved.item.imageId },
    compatibility: { os: 'linux', architecture: 'arm64', database: { engine: 'postgresql', major: 17 }, storageFormat: 'physical-pgdata.v1' },
    checkpoint: { bytes: checkpoint.length, sha256: sha(checkpoint) },
  };
  return { root, checkpoint, saved, options: { expectation, checkpointFile, imageInventory, imageDirectory, signal: new AbortController().signal } };
}

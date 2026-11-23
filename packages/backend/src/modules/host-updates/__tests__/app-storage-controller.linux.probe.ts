import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { AppStorageWitness, decodeAppStorageObservation } from '@/modules/host-updates/app-storage-observation';

// Run only inside the freshly owned, healthy candidate Core. The actual image
// supplies Dockerode; the bundled witness is pinned to the reviewed source.
const mode = process.argv[2];
let phase = 'preconditions';
const diagnostic: { hostStatus?: number; metadataVerified?: boolean; directoryMatches?: boolean; engineSocketMatches?: boolean } = {};

// This read-only diagnostic is not a storage grant. The real witness below
// must independently open, verify and reverify its own live connection.
async function observeTransport(appUrn: string, localDirectory: string) {
  const nonce = randomBytes(32).toString('hex');
  const payload = JSON.stringify({ appUrn, nonce });
  const body = await new Promise<Buffer>((resolve, reject) => {
    const request = http.request(
      {
        socketPath: '/run/orbis/host.sock',
        path: '/v1/app-storage/observe',
        method: 'POST',
        signal: AbortSignal.timeout(20_000),
        agent: false,
        headers: { Host: 'orbis', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
      },
      (response) => {
        diagnostic.hostStatus = response.statusCode;
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > 16384) {
            response.destroy();
            request.destroy();
            reject(new Error('Diagnostic response limit'));
          } else parts.push(part);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Diagnostic response aborted')));
        response.once('end', () => resolve(Buffer.concat(parts)));
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
  assert.equal(diagnostic.hostStatus, 200);
  const value = decodeAppStorageObservation(JSON.parse(body.toString('utf8')), { appUrn, nonce });
  diagnostic.metadataVerified = true;
  const directory = await fs.stat(localDirectory, { bigint: true });
  diagnostic.directoryMatches =
    value.containerPath === localDirectory &&
    value.directory.device === String(directory.dev) &&
    value.directory.inode === String(directory.ino) &&
    value.directory.uid === Number(directory.uid) &&
    value.directory.gid === Number(directory.gid) &&
    value.directory.mode === Number(directory.mode & 0o7777n);
  const socket = await fs.stat('/var/run/docker.sock', { bigint: true });
  diagnostic.engineSocketMatches = value.dockerSocket.device === String(socket.dev) && value.dockerSocket.inode === String(socket.ino);
}

async function qualify() {
  const Dockerode = createRequire('/app/package.json')('dockerode');
  const custom = mode === 'custom-app-positive';
  const localDirectory = custom ? '/app-data/_user/probe' : '/app-data/fixture/probe';
  const appUrn = custom ? 'probe:_user' : 'probe:fixture';
  assert.equal(process.platform, 'linux');
  assert.equal(process.geteuid?.(), 0);
  assert.equal(mode === 'positive' || mode === 'custom-app-positive' || mode === 'directory-drift', true);
  assert.equal(await fs.realpath(localDirectory), localDirectory);
  assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
  phase = 'host-transport';
  await observeTransport(appUrn, localDirectory);
  phase = 'witness-open';
  const witness = await AppStorageWitness.open({
    socketPath: '/run/orbis/host.sock',
    appUrn,
    localDirectory,
    docker: new Dockerode({ socketPath: '/var/run/docker.sock' }),
  });
  try {
    phase = 'witness-use';
    if (mode !== 'directory-drift') {
      const observation = await witness.use(async (_docker, value) => {
        const actual = await fs.stat(localDirectory);
        assert.equal(value.containerPath, localDirectory);
        assert.equal(value.directory.device, String(actual.dev));
        assert.equal(value.directory.inode, String(actual.ino));
        assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
        return {
          controllerId: value.controller.id,
          imageId: value.controller.imageId,
          directory: value.directory,
          daemonSha256: value.daemonSha256,
          mountTablesSha256: value.mountTablesSha256,
        };
      });
      process.stdout.write(`${JSON.stringify({ case: mode, passed: true, observation })}\n`);
    } else {
      const retained = `${localDirectory}-retained-${randomUUID()}`;
      let moved = false;
      let replacement = false;
      try {
        await assert.rejects(
          witness.use(async () => {
            await fs.rename(localDirectory, retained);
            moved = true;
            await fs.mkdir(localDirectory, { mode: 0o700 });
            replacement = true;
          }),
          /storage binding could not be verified/,
        );
        // A refusal before the intended effect would not qualify this case.
        assert.equal(moved && replacement, true);
      } finally {
        if (replacement) await fs.rmdir(localDirectory);
        if (moved) await fs.rename(retained, localDirectory);
      }
      assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
      process.stdout.write(`${JSON.stringify({ case: mode, passed: true, originalRestored: true })}\n`);
    }
  } finally {
    const previous = phase;
    phase = 'witness-close';
    await witness.close();
    phase = previous;
  }
}

qualify().catch(() => {
  process.stdout.write(`${JSON.stringify({ case: mode, passed: false, failedPhase: phase, diagnostic })}\n`);
  process.exitCode = 1;
});

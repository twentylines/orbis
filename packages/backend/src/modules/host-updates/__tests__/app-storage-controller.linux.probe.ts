import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { AppStorageWitness } from '@/modules/host-updates/app-storage-observation';

// Run only inside the freshly owned, healthy candidate Core. The actual image
// supplies Dockerode; the bundled witness is pinned to the reviewed source.
const Dockerode = createRequire('/app/package.json')('dockerode');
const localDirectory = '/app-data/fixture/probe';
const appUrn = 'probe:fixture';
const mode = process.argv[2];
assert.equal(process.platform, 'linux');
assert.equal(process.geteuid?.(), 0);
assert.equal(mode === 'positive' || mode === 'directory-drift', true);
assert.equal(await fs.realpath(localDirectory), localDirectory);
assert.equal(await fs.readFile(`${localDirectory}/marker`, 'utf8'), 'scoped fixture\n');
const witness = await AppStorageWitness.open({
  socketPath: '/run/orbis/host.sock',
  appUrn,
  localDirectory,
  docker: new Dockerode({ socketPath: '/var/run/docker.sock' }),
});
try {
  if (mode === 'positive') {
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
  await witness.close();
}

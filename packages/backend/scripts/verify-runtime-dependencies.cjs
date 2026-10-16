const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

(async () => {
  const root = path.resolve(process.argv[2] || process.cwd());
  const modules = path.join(root, 'node_modules');
  const manifest = JSON.parse(fs.readFileSync(path.join(modules, '.orbis-runtime-dependencies.json'), 'utf8'));
  assert.equal(manifest.schema, 'orbis.runtime-dependencies.v1');
  assert.match(manifest.lockfileSha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(manifest.packages) && manifest.packages.length > 0);
  for (const entry of manifest.packages) {
    const directory = path.resolve(modules, entry.path);
    assert.ok(directory.startsWith(`${modules}${path.sep}`), 'Runtime manifest path escapes its modules');
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(metadata.name, entry.name);
    assert.equal(metadata.version, entry.version);
  }
  const runtime = createRequire(path.join(root, 'runtime-probe.cjs'));
  const argon2 = runtime('argon2');
  const sample = 'Orbis image build check';
  const encoded = await argon2.hash(sample);
  assert.equal(await argon2.verify(encoded, sample), true);
  assert.equal(await argon2.verify(encoded, 'different sample'), false);
  class Example {}
  const instance = runtime('class-transformer').plainToInstance(Example, { name: 'Orbis' });
  assert.ok(instance instanceof Example);
  assert.equal(instance.name, 'Orbis');
  process.stdout.write(
    `${JSON.stringify({ lockfileSha256: manifest.lockfileSha256, packages: manifest.packages.length, nativeHashVerified: true, transformerVerified: true, node: process.version, architecture: process.arch })}\n`,
  );
})().catch((error) => {
  process.stderr.write(`Runtime dependency verification failed: ${error.message}\n`);
  process.exitCode = 1;
});

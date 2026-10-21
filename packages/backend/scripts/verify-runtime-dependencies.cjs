const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

const verifyArchiveRuntime = () => {
  const archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbis-archive-runtime-'));
  try {
    const source = path.join(archiveRoot, 'source');
    const restored = path.join(archiveRoot, 'restored');
    fs.mkdirSync(source);
    fs.mkdirSync(restored);
    const nested = path.join(source, '.nested');
    fs.mkdirSync(nested);
    const file = path.join(nested, 'payload.bin');
    const payload = Buffer.from([0, 255, 128, 10, 13, 0]);
    fs.writeFileSync(file, payload);
    if (process.platform === 'linux' && process.getuid() === 0) {
      fs.chownSync(file, 1001, 1002);
      fs.chownSync(nested, 1001, 1002);
    }
    fs.chmodSync(file, 0o640);
    fs.utimesSync(file, 1700000000.123456, 1700000000.654321);
    fs.chmodSync(nested, 0o750);
    fs.utimesSync(nested, 1700000010.123456, 1700000010.654321);
    const original = fs.statSync(file);
    const originalTime = fs.statSync(file, { bigint: true }).mtimeNs;
    assert.notEqual(originalTime % 1000000n, 0n);
    const metadataOnly = path.join(archiveRoot, 'metadata-only');
    fs.writeFileSync(metadataOnly, 'Keep these different destination bytes');
    if (process.platform === 'linux') {
      execFileSync('cp', ['--attributes-only', '--preserve=mode,ownership,timestamps', '--', file, metadataOnly]);
    } else {
      execFileSync('touch', ['-r', file, '--', metadataOnly]);
    }
    assert.equal(fs.readFileSync(metadataOnly, 'utf8'), 'Keep these different destination bytes');
    assert.equal(fs.statSync(metadataOnly, { bigint: true }).mtimeNs, originalTime);
    const originalDirectory = fs.statSync(nested);
    const archive = path.join(archiveRoot, 'backup.tar.gz');
    execFileSync('tar', ['--format=pax', '-czpf', archive, '-C', source, '.']);
    const archiveMime = execFileSync('file', ['--brief', '--mime-type', archive], { encoding: 'utf8' }).trim();
    assert.ok(['application/gzip', 'application/x-gzip'].includes(archiveMime), `Unexpected backup MIME type: ${archiveMime}`);
    const paths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    const entries = execFileSync('tar', ['-tzvf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(entries.length, paths.length);
    assert.ok(paths.some((entry) => entry.endsWith('payload.bin')));
    execFileSync('tar', ['-xzpf', archive, '-C', restored]);
    const extractedDirectory = path.join(restored, '.nested');
    const extracted = path.join(extractedDirectory, 'payload.bin');
    const actual = fs.statSync(extracted);
    assert.deepEqual(fs.readFileSync(extracted), payload);
    assert.equal(fs.statSync(extracted, { bigint: true }).mtimeNs, originalTime);
    assert.equal(fs.statSync(extractedDirectory, { bigint: true }).mtimeNs, fs.statSync(nested, { bigint: true }).mtimeNs);
    assert.deepEqual([actual.uid, actual.gid, actual.mode & 0o7777, actual.mtimeMs], [original.uid, original.gid, 0o640, original.mtimeMs]);
    const directory = fs.statSync(extractedDirectory);
    assert.deepEqual(
      [directory.uid, directory.gid, directory.mode & 0o7777, directory.mtimeMs],
      [originalDirectory.uid, originalDirectory.gid, 0o750, originalDirectory.mtimeMs],
    );
    return {
      archiveMime,
      archiveRoundTripVerified: true,
      archiveOwnershipVerified: true,
      archiveDirectoryMetadataVerified: true,
      archiveSubsecondTimestampsVerified: true,
      metadataOnlyCopyVerified: true,
      archiveUid: actual.uid,
      archiveGid: actual.gid,
    };
  } finally {
    fs.rmSync(archiveRoot, { recursive: true, force: true });
  }
};

(async () => {
  if (process.argv[2] === '--archive-only') {
    process.stdout.write(
      `${JSON.stringify({ ...verifyArchiveRuntime(), node: process.version, architecture: process.arch, uid: process.getuid?.() })}\n`,
    );
    return;
  }
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
  const archives = verifyArchiveRuntime();
  process.stdout.write(
    `${JSON.stringify({ lockfileSha256: manifest.lockfileSha256, packages: manifest.packages.length, nativeHashVerified: true, transformerVerified: true, ...archives, node: process.version, architecture: process.arch })}\n`,
  );
})().catch((error) => {
  process.stderr.write(`Runtime dependency verification failed: ${error.message}\n`);
  process.exitCode = 1;
});

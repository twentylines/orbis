import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getCliSecret } from '../permissions-helpers.ts';

const canChangeUid = process.platform === 'linux' && process.getuid?.() === 0;
const checkout = fileURLToPath(new URL('../../../../../../', import.meta.url));
const helperSource = fs.readFileSync(new URL('../permissions-helpers.ts', import.meta.url));
const serviceUid = 65534;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  // Root fixtures require an explicitly allocated checkout-local parent. Never
  // default to a host temporary directory or an installation's key storage.
  const parent = process.env.ORBIS_CLI_KEY_TEST_ROOT;
  assert.equal(typeof parent, 'string', 'Allocate an isolated CLI-key test directory first');
  assert.equal(path.dirname(parent), checkout.replace(/\/$/, ''));
  assert.match(path.basename(parent), /^\.orbis-permissions-[A-Za-z0-9]{6}$/);
  assert.equal(fs.realpathSync(parent), parent);
  const stat = fs.lstatSync(parent);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.mode & 0o022, 0);
  const root = fs.mkdtempSync(path.join(parent, 'case-'));
  fs.writeFileSync(path.join(root, 'permissions-helpers.ts'), helperSource, { mode: 0o644 });
  fs.chmodSync(path.join(root, 'permissions-helpers.ts'), 0o644);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function asService(code, root, ...args) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', code, root, ...args], {
    uid: serviceUid,
    gid: serviceUid,
    cwd: root,
    encoding: 'utf8',
    timeout: 20_000,
  });
  // Neither test output nor assertion diagnostics may contain credential bytes.
  const reason =
    ['EACCES', 'ERR_MODULE_NOT_FOUND', 'ERR_ASSERTION', 'ETIMEDOUT'].find((code) => result.stderr?.includes(code) || result.error?.code === code) ??
    'nonzero exit';
  assert.equal(result.status === 0, true, `The isolated service-user check failed (${reason})`);
  assert.equal(result.stdout.length === 0, true, 'The isolated check must not print credentials');
}

test('another UID keeps shared access while the CLI key stays private during permission repair', { skip: !canChangeUid }, async (t) => {
  const root = fixture(t);
  fs.chmodSync(root, 0o755);
  const directories = ['state', 'apps', 'repos', 'logs', 'traefik', 'user-config', 'data'].map((name) => path.join(root, name));
  for (const directory of directories) {
    fs.mkdirSync(directory, { mode: 0o777 });
    fs.chmodSync(directory, 0o777);
    for (let index = 0; index < 128; index++) {
      fs.writeFileSync(path.join(directory, String(index)), 'shared fixture', { mode: 0o644 });
      fs.chmodSync(path.join(directory, String(index)), 0o644);
    }
  }
  const original = hash(await getCliSecret(root));
  const access = () =>
    asService(
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    const root = process.argv[1];
    assert.equal(fs.readFileSync(root + '/apps/0', 'utf8'), 'shared fixture');
    fs.writeFileSync(root + '/user-config/shared', 'shared fixture');
    assert.throws(() => fs.readFileSync(root + '/.secrets/cli-secret'), { code: 'EACCES' });
    assert.throws(() => fs.renameSync(root + '/.secrets/cli-secret', root + '/state/alias'), { code: 'EACCES' });
    assert.throws(() => fs.linkSync(root + '/.secrets/cli-secret', root + '/state/alias'), { code: 'EACCES' });
  `,
      root,
    );
  access();
  // Keep an owned repair process active while another UID checks access. Every
  // chmod is limited to generated shared trees, never .secrets or host files.
  const ready = path.join(root, 'repair-ready');
  const finish = path.join(root, 'repair-finish');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import fs from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const [ready, finish, ...directories] = process.argv.slice(1);
    const deadline = Date.now() + 10000;
    do {
      if (Date.now() > deadline) process.exit(1);
      if (spawnSync('chmod', ['-R', '777', ...directories]).status !== 0) process.exit(1);
      fs.writeFileSync(ready, 'ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (!fs.existsSync(finish));
  `,
      ready,
      finish,
      ...directories,
    ],
    { stdio: 'ignore' },
  );
  const repaired = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('Fixture permission repair failed'))));
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(ready)) {
      assert.equal(Date.now() < deadline && child.exitCode === null, true, 'Fixture repair did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    access();
    assert.equal(child.exitCode, null, 'Access must be checked while permission repair is still active');
  } finally {
    fs.writeFileSync(finish, 'finish');
    await repaired;
  }
  access();
  assert.equal(hash(await getCliSecret(root)) === original, true);
  assert.equal(fs.statSync(path.join(root, '.secrets')).mode & 0o7777, 0o700);
  assert.equal(fs.statSync(path.join(root, '.secrets/cli-secret')).mode & 0o7777, 0o600);
});

test('rejects a private key planted by another UID', { skip: !canChangeUid }, async (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, '.secrets'), { mode: 0o700 });
  const file = path.join(root, '.secrets/cli-secret');
  fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  fs.chownSync(file, serviceUid, serviceUid);
  const before = hash(fs.readFileSync(file));
  await assert.rejects(getCliSecret(root), /CLI authentication storage/);
  assert.equal(hash(fs.readFileSync(file)) === before, true);
  assert.equal(fs.statSync(file).uid, serviceUid);
});

test('a service UID creates and persists its private key', { skip: !canChangeUid }, (t) => {
  const root = fixture(t);
  fs.chownSync(root, serviceUid, serviceUid);
  fs.chmodSync(root, 0o755);
  asService(
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { getCliSecret } from ${JSON.stringify(pathToFileURL(path.join(root, 'permissions-helpers.ts')).href)};
    const root = process.argv[1];
    const key = await getCliSecret(root);
    assert.equal(/^[a-f0-9]{64}$/.test(key), true);
    assert.equal((await getCliSecret(root)) === key, true);
    const file = fs.statSync(root + '/.secrets/cli-secret');
    assert.equal(file.uid, process.geteuid());
    assert.equal(file.mode & 0o7777, 0o600);
    assert.equal(fs.statSync(root + '/.secrets').mode & 0o7777, 0o700);
  `,
    root,
  );
});

test('a service UID rotates a readable root-owned exposed key and retains its replacement', { skip: !canChangeUid }, (t) => {
  const root = fixture(t);
  fs.chownSync(root, serviceUid, serviceUid);
  fs.chmodSync(root, 0o755);
  const directory = path.join(root, '.secrets');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chownSync(directory, serviceUid, serviceUid);
  const file = path.join(directory, 'cli-secret');
  fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o644 });
  const original = hash(fs.readFileSync(file));
  asService(
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { getCliSecret } from ${JSON.stringify(pathToFileURL(path.join(root, 'permissions-helpers.ts')).href)};
    const root = process.argv[1];
    const key = await getCliSecret(root);
    assert.equal(createHash('sha256').update(key).digest('hex') === process.argv[2], false);
    assert.equal((await getCliSecret(root)) === key, true);
    assert.equal(fs.statSync(root + '/.secrets/cli-secret').uid, process.geteuid());
    assert.equal(fs.statSync(root + '/.secrets/cli-secret').mode & 0o7777, 0o600);
  `,
    root,
    original,
  );
});

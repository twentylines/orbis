import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { packageRuntimeDependencies } from './package-runtime-dependencies';

const temporary: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'orbis-runtime-test-'));
  temporary.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  const lockfile = join(root, 'bun.lock');
  writeFileSync(lockfile, 'owned frozen dependency fixture');
  return { root, workspace, lockfile, output: join(root, 'runtime', 'node_modules') };
};
const module = (directory: string, metadata: Record<string, unknown>, source = `module.exports = ${JSON.stringify(metadata.version)};`) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ main: 'index.js', ...metadata }));
  writeFileSync(join(directory, 'index.js'), source);
};
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('frozen runtime dependency packaging', () => {
  it('retains resolved transitive versions instead of flattening incompatible dependencies', () => {
    const { root, workspace, output, lockfile } = fixture();
    const alpha = join(root, 'node_modules', 'alpha');
    module(
      alpha,
      { name: 'alpha', version: '1.0.0', dependencies: { shared: '^2' }, devDependencies: { missingDev: '*' } },
      "module.exports = require('shared');",
    );
    module(join(alpha, 'node_modules', 'shared'), { name: 'shared', version: '2.0.0' });
    module(
      join(root, 'node_modules', 'beta'),
      { name: 'beta', version: '1.0.0', dependencies: { shared: '^1' } },
      "module.exports = require('shared');",
    );
    module(join(root, 'node_modules', 'shared'), { name: 'shared', version: '1.0.0' });
    const result = packageRuntimeDependencies(workspace, output, lockfile, ['alpha', 'beta']);
    const require = createRequire(join(root, 'runtime', 'probe.cjs'));
    expect(require('alpha')).toBe('2.0.0');
    expect(require('beta')).toBe('1.0.0');
    expect(result.packages).toHaveLength(4);
    expect(result.lockfileSha256).toBe(createHash('sha256').update(readFileSync(lockfile)).digest('hex'));
    expect(JSON.parse(readFileSync(join(output, '.orbis-runtime-dependencies.json'), 'utf8'))).toEqual(result);
  });

  it('links dependency cycles only within the packaged tree', () => {
    const { root, workspace, output, lockfile } = fixture();
    module(join(root, 'node_modules', 'alpha'), { name: 'alpha', version: '1.0.0', dependencies: { beta: '*' } });
    module(join(root, 'node_modules', 'beta'), { name: 'beta', version: '1.0.0', dependencies: { alpha: '*' } });
    packageRuntimeDependencies(workspace, output, lockfile, ['alpha']);
    const loop = join(output, 'alpha', 'node_modules', 'beta', 'node_modules', 'alpha');
    expect(lstatSync(loop).isSymbolicLink()).toBe(true);
    expect(realpathSync(loop)).toBe(realpathSync(join(output, 'alpha')));
  });

  it('skips absent optional dependencies and requires mandatory peers', () => {
    const { root, workspace, output, lockfile } = fixture();
    module(join(root, 'node_modules', 'alpha'), {
      name: 'alpha',
      version: '1.0.0',
      optionalDependencies: { optional: '*' },
      peerDependencies: { peer: '*', 'optional-peer': '*' },
      peerDependenciesMeta: { 'optional-peer': { optional: true } },
    });
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('alpha → peer');
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(root, 'runtime')).some((name) => name.startsWith('.orbis-runtime-'))).toBe(false);
    module(join(root, 'node_modules', 'peer'), { name: 'peer', version: '3.0.0' });
    expect(packageRuntimeDependencies(workspace, output, lockfile, ['alpha']).packages).toHaveLength(2);
  });

  it('refuses an existing destination without changing it', () => {
    const { workspace, output, lockfile } = fixture();
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'keep'), 'unchanged');
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, [])).toThrow('must be new');
    expect(readFileSync(join(output, 'keep'), 'utf8')).toBe('unchanged');
  });

  it('does not package a dependency resolved outside the frozen installation', () => {
    const { root, workspace, output, lockfile } = fixture();
    const outside = fixture().root;
    module(join(outside, 'alpha'), { name: 'alpha', version: '9.0.0' });
    mkdirSync(join(root, 'node_modules'));
    symlinkSync(join(outside, 'alpha'), join(root, 'node_modules', 'alpha'), 'dir');
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('Missing installed runtime dependency: alpha');
    expect(existsSync(output)).toBe(false);
  });

  it('rejects package symlinks that escape their package', () => {
    const { root, workspace, output, lockfile } = fixture();
    const alpha = join(root, 'node_modules', 'alpha');
    module(alpha, { name: 'alpha', version: '1.0.0' });
    writeFileSync(join(root, 'outside'), 'must not be packaged');
    symlinkSync(join(root, 'outside'), join(alpha, 'escape'));
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('escaping symlink');
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(join(root, 'outside'), 'utf8')).toBe('must not be packaged');
  });

  it.each([
    '.env',
    '.env.production',
    '.ENV.LOCAL',
    'service.env',
    '.env.example',
    'service.env.sample',
    'env.template',
    'environment.example',
    '.envrc',
    '.npmrc',
    '.netrc',
    'id_rsa',
    'id_ed25519',
  ])('rejects private configuration %s and removes incomplete output', (filename) => {
    const { root, workspace, output, lockfile } = fixture();
    const alpha = join(root, 'node_modules', 'alpha');
    module(alpha, { name: 'alpha', version: '1.0.0' });
    writeFileSync(join(alpha, filename), 'synthetic private configuration');
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('prohibited configuration file');
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(root, 'runtime')).some((name) => name.startsWith('.orbis-runtime-'))).toBe(false);
    expect(readFileSync(join(alpha, filename), 'utf8')).toBe('synthetic private configuration');
  });

  it('rejects configuration hidden behind an otherwise permitted symlink', () => {
    const { root, workspace, output, lockfile } = fixture();
    const alpha = join(root, 'node_modules', 'alpha');
    module(alpha, { name: 'alpha', version: '1.0.0' });
    const hidden = join(alpha, 'node_modules', 'local');
    mkdirSync(hidden, { recursive: true });
    writeFileSync(join(hidden, '.env'), 'synthetic private configuration');
    symlinkSync(join(hidden, '.env'), join(alpha, 'runtime-config'));
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('prohibited configuration file');
    expect(existsSync(output)).toBe(false);
    expect(readdirSync(join(root, 'runtime')).some((name) => name.startsWith('.orbis-runtime-'))).toBe(false);
  });

  it('checks transitive runtime packages for private configuration too', () => {
    const { root, workspace, output, lockfile } = fixture();
    module(join(root, 'node_modules', 'alpha'), { name: 'alpha', version: '1.0.0', dependencies: { beta: '*' } });
    const beta = join(root, 'node_modules', 'beta');
    module(beta, { name: 'beta', version: '1.0.0' });
    writeFileSync(join(beta, '.env.local'), 'synthetic private configuration');
    expect(() => packageRuntimeDependencies(workspace, output, lockfile, ['alpha'])).toThrow('prohibited configuration file');
    expect(existsSync(output)).toBe(false);
  });

  it('loads the installed locked native hash and transformer modules from the standalone output', async () => {
    const { root, output } = fixture();
    const workspace = resolve(import.meta.dirname, '..');
    const result = packageRuntimeDependencies(workspace, output, resolve(workspace, '../../bun.lock'));
    const require = createRequire(join(root, 'runtime', 'probe.cjs'));
    const installed = createRequire(join(workspace, 'package.json'));
    for (const name of ['argon2', 'class-transformer']) {
      expect(require(`${name}/package.json`).version).toBe(installed(`${name}/package.json`).version);
      expect(result.packages.find((entry) => entry.path === name)?.version).toBe(installed(`${name}/package.json`).version);
    }
    const argon2 = require('argon2');
    const encoded = await argon2.hash('orbis-runtime-package-check');
    expect(await argon2.verify(encoded, 'orbis-runtime-package-check')).toBe(true);
    expect(await argon2.verify(encoded, 'other-value')).toBe(false);
    class Example {
      name = '';
    }
    const value = require('class-transformer').plainToInstance(Example, { name: 'Orbis' });
    expect(value).toBeInstanceOf(Example);
    expect(value.name).toBe('Orbis');
    const nativeNode = spawnSync('node', [join(workspace, 'scripts', 'verify-runtime-dependencies.cjs'), join(root, 'runtime')], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(nativeNode.status, nativeNode.stderr).toBe(0);
    expect(JSON.parse(nativeNode.stdout)).toMatchObject({
      nativeHashVerified: true,
      transformerVerified: true,
      lockfileSha256: result.lockfileSha256,
    });
  });
});

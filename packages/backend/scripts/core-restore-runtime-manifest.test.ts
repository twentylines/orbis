import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateCoreRestoreRuntimeManifest, writeCoreRestoreRuntimeManifest } from './core-restore-runtime-manifest';

const bytes = (value: string) => Buffer.from(value);
function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Fixture item is missing');
  return value;
}
const roots = [
  'core-inspection-worker.mjs',
  'core-source-configuration-worker.mjs',
  'core-clean-target-bootstrap-worker.mjs',
  'core-clean-target-worker.mjs',
];
const entry = (index: number, when = 1731334056989 + index) => ({
  idx: index,
  version: '7',
  when,
  tag: `${String(index).padStart(4, '0')}_test`,
  breakpoints: true,
});
const journalFile = (entries: unknown[] = [entry(0), entry(1)]) => ({
  name: 'meta/_journal.json',
  bytes: bytes(JSON.stringify({ version: '7', dialect: 'postgresql', entries })),
});
function fixture() {
  return {
    dotenvVersion: '17.2.3',
    workers: [
      ...roots.map((name) => ({ name, bytes: bytes('import "./core-publication-test.mjs";') })),
      { name: 'core-publication-test.mjs', bytes: bytes('import "node:fs"; import "dotenv"; export const value = 1;') },
    ],
    migrations: [journalFile(), { name: '0000_test.sql', bytes: bytes('SELECT 1;') }, { name: '0001_test.sql', bytes: bytes('SELECT 2;') }],
  };
}
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function diskFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'core-restore-manifest-'));
  temporary.push(root);
  const dist = path.join(root, 'dist');
  const migrations = path.join(root, 'migrations');
  await mkdir(dist);
  await mkdir(path.join(migrations, 'meta'), { recursive: true });
  const input = fixture();
  const captureOutputs: string[] = [];
  for (const file of input.workers) {
    const filename = path.join(dist, roots.includes(file.name) ? file.name.replace(/\.mjs$/, '.js') : file.name);
    await writeFile(filename, file.bytes);
    captureOutputs.push(filename);
  }
  for (const file of input.migrations) await writeFile(path.join(migrations, file.name), file.bytes);
  await writeFile(path.join(migrations, 'meta', '0000_snapshot.json'), 'excluded snapshot');
  return { dist, migrations, captureOutputs };
}

describe('core restore runtime release manifest', () => {
  it('packages every advertised worker at its runtime manifest path', async () => {
    const input = fixture();
    for (const name of ['core-restoration-worker.mjs', 'core-live-reconciliation-worker.mjs'])
      input.workers.push({ name, bytes: bytes('import "./core-publication-test.mjs";') });
    const manifest = JSON.parse(generateCoreRestoreRuntimeManifest(input));
    const dockerfile = await readFile(new URL('../../../Dockerfile', import.meta.url), 'utf8');
    const moves = new Map([...dockerfile.matchAll(/\bmv\s+(\S+\.js)\s+(\S+\.mjs)\b/g)].map((match) => [match[1], match[2]]));
    for (const name of Object.keys(manifest.workers.files)) {
      if (name.endsWith('-worker.mjs')) expect(moves.get(name.replace(/\.mjs$/, '.js'))).toBe(name);
    }
  });

  it.each(['core-restoration-worker.mjs', 'core-live-reconciliation-worker.mjs'])(
    'includes optional %s without adding an old-version prerequisite',
    (name) => {
      const input = fixture();
      expect(JSON.parse(generateCoreRestoreRuntimeManifest(input)).workers.files[name]).toBeUndefined();
      const worker = { name, bytes: bytes('import "./core-publication-test.mjs";') };
      input.workers.push(worker);
      expect(JSON.parse(generateCoreRestoreRuntimeManifest(input)).workers.files[worker.name]).toEqual({
        bytes: worker.bytes.length,
        sha256: createHash('sha256').update(worker.bytes).digest('hex'),
      });
      input.workers = input.workers.filter((file) => file.name !== roots[0]);
      expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow('root is missing');
      const unknown = fixture();
      unknown.workers.push({ ...worker, name: 'core-restoration-other.mjs' });
      expect(() => generateCoreRestoreRuntimeManifest(unknown)).toThrow('unknown file');
    },
  );

  it.each(['core-restoration-worker', 'core-live-reconciliation-worker'])(
    'hashes emitted optional %s and its dependency closure from disk',
    async (name) => {
      const options = await diskFixture();
      const source = bytes('import "./core-publication-test.mjs";');
      const worker = path.join(options.dist, `${name}.js`);
      await writeFile(worker, source);
      options.captureOutputs.push(worker);
      const manifest = JSON.parse(await readFile(await writeCoreRestoreRuntimeManifest(options), 'utf8'));
      expect(manifest.workers.files[`${name}.mjs`]).toEqual({
        bytes: source.length,
        sha256: createHash('sha256').update(source).digest('hex'),
      });
      expect(Object.keys(manifest.workers.files)).toHaveLength(fixture().workers.length + 1);
    },
  );

  it('writes sorted compact deterministic JSON with hashes of exact bytes and journal timestamps', () => {
    const input = fixture();
    const actual = generateCoreRestoreRuntimeManifest(input);
    expect(actual).toBe(
      generateCoreRestoreRuntimeManifest({ ...input, workers: input.workers.slice().reverse(), migrations: input.migrations.slice().reverse() }),
    );
    expect(actual.endsWith('\n')).toBe(false);
    const manifest = JSON.parse(actual);
    expect(Object.keys(manifest)).toEqual(['graph', 'migrations', 'parserProfile', 'qualification', 'schema', 'workers']);
    expect(manifest.schema).toBe('orbis.core-restore-release.v1');
    expect(manifest.workers.files['core-inspection-worker.mjs']).toEqual({
      bytes: item(input.workers, 0).bytes.length,
      sha256: createHash('sha256').update(item(input.workers, 0).bytes).digest('hex'),
    });
    expect(manifest.graph).toEqual([
      { created_at: '1731334056989', hash: createHash('sha256').update('SELECT 1;').digest('hex') },
      { created_at: '1731334056990', hash: createHash('sha256').update('SELECT 2;').digest('hex') },
    ]);
    expect(manifest.qualification).toEqual({
      schema: 'orbis.core-restore-source-qualification.v1',
      scope: 'same-published-controller-only',
      parserProfile: 'orbis.source-configuration.dotenv-17.2.3.v1',
      configuration: 'captured-complete-configuration',
      sourceWrites: false,
      activation: false,
    });
    expect(manifest.migrations.files['meta/_journal.json'].sha256).toBe(createHash('sha256').update(item(input.migrations, 0).bytes).digest('hex'));
    expect(actual).toContain('"created_at":"1731334056989","hash":');
  });

  it('rejects unqualified parser versions', () => {
    expect(() => generateCoreRestoreRuntimeManifest({ ...fixture(), dotenvVersion: '17.2.2' })).toThrow('dotenv 17.2.3');
  });

  it.each(['new journal version', 'extra journal field', 'extra entry field', 'SQL NUL', 'SQL invalid UTF8'])(
    'rejects input the Root migration reader cannot approve: %s',
    (mode) => {
      const input = fixture();
      const journal = { version: mode === 'new journal version' ? '8' : '7', dialect: 'postgresql', entries: [entry(0), entry(1)] };
      if (mode === 'extra journal field') Object.assign(journal, { extra: true });
      if (mode === 'extra entry field') Object.assign(item(journal.entries, 0), { extra: true });
      input.migrations[0] = { name: 'meta/_journal.json', bytes: bytes(JSON.stringify(journal)) };
      if (mode === 'SQL NUL') item(input.migrations, 1).bytes = bytes('SELECT 1;\0');
      if (mode === 'SQL invalid UTF8') item(input.migrations, 1).bytes = Buffer.from([255]);
      expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow();
    },
  );

  it.each(['core-publication-UPPER.mjs', 'core-publication-under_score.mjs'])('rejects runtime-incompatible chunk name %s', (name) => {
    const input = fixture();
    input.workers.push({ name, bytes: bytes('export {};') });
    expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow('unknown file');
  });

  it.each(['missing root', 'missing chunk', 'duplicate worker', 'unknown file', 'parent import', 'unknown local import', 'absolute import'])(
    'rejects unsafe worker closure: %s',
    (mode) => {
      const input = fixture();
      if (mode === 'missing root') input.workers.shift();
      if (mode === 'missing chunk') input.workers.pop();
      if (mode === 'duplicate worker') input.workers.push(item(input.workers, 0));
      if (mode === 'unknown file') input.workers.push({ name: 'main.js', bytes: bytes('export {};') });
      if (mode.endsWith('import')) {
        const dependency =
          mode === 'parent import' ? '../core-publication-test.mjs' : mode === 'absolute import' ? '/private/module.js' : './main.js';
        item(input.workers, 0).bytes = bytes(`import ${JSON.stringify(dependency)};`);
      }
      expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow();
    },
  );

  it.each([
    ['duplicate index', [entry(0), entry(0)]],
    ['out of order', [entry(1), entry(0)]],
    ['duplicate timestamp', [entry(0), entry(1, 1731334056989)]],
    ['unsafe timestamp', [entry(0, Number.MAX_SAFE_INTEGER + 1)]],
    ['zero timestamp', [entry(0, 0)]],
    ['fractional timestamp', [entry(0, 1.5)]],
    ['unsafe tag', [{ ...entry(0), tag: '../0000_test' }]],
    ['mismatched tag index', [{ ...entry(0), tag: '0001_test' }]],
    ['missing breakpoints', [{ ...entry(0), breakpoints: undefined }]],
  ])('rejects malformed journal: %s', (_name, entries) => {
    const input = fixture();
    input.migrations[0] = journalFile(entries);
    expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow();
  });

  it.each(['missing SQL', 'extra SQL', 'duplicate SQL', 'snapshot', 'missing journal', 'invalid JSON', 'invalid UTF8'])(
    'rejects unsafe migration inventory: %s',
    (mode) => {
      const input = fixture();
      if (mode === 'missing SQL') input.migrations.pop();
      if (mode === 'extra SQL') input.migrations.push({ name: '0002_test.sql', bytes: bytes('SELECT 3;') });
      if (mode === 'duplicate SQL') input.migrations.push(item(input.migrations, 1));
      if (mode === 'snapshot') input.migrations.push({ name: 'meta/0000_snapshot.json', bytes: bytes('{}') });
      if (mode === 'missing journal') input.migrations.shift();
      if (mode === 'invalid JSON') item(input.migrations, 0).bytes = bytes('{');
      if (mode === 'invalid UTF8') item(input.migrations, 0).bytes = Buffer.from([255]);
      expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow();
    },
  );

  it('enforces file count, individual sizes, total sizes, and nonempty files', () => {
    const input = fixture();
    expect(() => generateCoreRestoreRuntimeManifest({ ...input, workers: [...input.workers, ...input.workers] })).toThrow();
    item(input.workers, 0).bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
    expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow('size');
    item(input.workers, 0).bytes = Buffer.alloc(0);
    expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow('size');
    const many = Array.from({ length: 65 }, (_, index) => ({ name: `core-publication-${index}.mjs`, bytes: bytes('export {};') }));
    expect(() => generateCoreRestoreRuntimeManifest({ ...fixture(), workers: many })).toThrow('count');
    const large = fixture();
    large.workers = large.workers.map((file) => ({ ...file, bytes: Buffer.alloc(16 * 1024 * 1024, 32) }));
    expect(() => generateCoreRestoreRuntimeManifest(large)).toThrow('total size');
    item(large.migrations, 1).bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
    expect(() => generateCoreRestoreRuntimeManifest({ ...fixture(), migrations: large.migrations })).toThrow('size');
    const migrationCount = fixture();
    migrationCount.migrations = Array.from({ length: 4098 }, () => item(migrationCount.migrations, 0));
    expect(() => generateCoreRestoreRuntimeManifest(migrationCount)).toThrow('count');
    const migrationTotal = fixture();
    migrationTotal.migrations = [
      journalFile(Array.from({ length: 5 }, (_, index) => entry(index))),
      ...Array.from({ length: 5 }, (_, index) => ({ name: `${String(index).padStart(4, '0')}_test.sql`, bytes: Buffer.alloc(4 * 1024 * 1024, 32) })),
    ];
    expect(() => generateCoreRestoreRuntimeManifest(migrationTotal)).toThrow('total size');
  });

  it.each(['file:///private/module.js', 'https://example.invalid/module.js', 'node:/private/module', 'pkg/../other', 'C:\\private\\module.js'])(
    'rejects unsafe dependency specifier %s',
    (dependency) => {
      const input = fixture();
      item(input.workers, 0).bytes = bytes(`import ${JSON.stringify(dependency)};`);
      expect(() => generateCoreRestoreRuntimeManifest(input)).toThrow('unsafe dependency');
    },
  );

  it('reads real build output names, excludes snapshots and writes once without a newline', async () => {
    const options = await diskFixture();
    const destination = await writeCoreRestoreRuntimeManifest(options);
    expect(await readFile(destination, 'utf8')).toBe(generateCoreRestoreRuntimeManifest(fixture()));
    await expect(writeCoreRestoreRuntimeManifest(options)).rejects.toThrow();
  });

  it.each(['worker symlink', 'journal symlink', 'SQL symlink', 'worker directory', 'unknown output', 'outside output', 'extra SQL', 'meta symlink'])(
    'rejects unsafe filesystem selection: %s',
    async (mode) => {
      const options = await diskFixture();
      if (mode.endsWith('symlink') || mode === 'worker directory') {
        const name =
          mode === 'journal symlink'
            ? path.join(options.migrations, 'meta/_journal.json')
            : mode === 'SQL symlink'
              ? path.join(options.migrations, '0000_test.sql')
              : mode === 'meta symlink'
                ? path.join(options.migrations, 'meta')
                : item(options.captureOutputs, 0);
        await rm(name, { recursive: true });
        if (mode === 'worker directory') await mkdir(name);
        else await symlink(item(options.captureOutputs, 1), name);
      }
      if (mode === 'unknown output') options.captureOutputs.push(path.join(options.dist, 'main.js'));
      if (mode === 'outside output') options.captureOutputs[0] = path.join(options.dist, '..', 'core-inspection-worker.js');
      if (mode === 'extra SQL') await writeFile(path.join(options.migrations, '0002_test.sql'), 'SELECT 3;');
      await expect(writeCoreRestoreRuntimeManifest(options)).rejects.toThrow();
    },
  );
});

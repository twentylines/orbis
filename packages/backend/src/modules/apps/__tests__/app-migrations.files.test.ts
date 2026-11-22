import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appMigrationFileLimit, readAppMigrationIds, readAppMigrationSources } from '../app-migrations';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'app-migration-source-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
const directory = () => path.join(root, 'migrations');
async function file(name = '001-first.yml', content: string | Uint8Array = 'opaque historical content') {
  await fs.mkdir(directory(), { recursive: true });
  const selected = path.join(directory(), name);
  await fs.writeFile(selected, content);
  return selected;
}

it('observes absence without allocating any migration storage', async () => {
  await expect(readAppMigrationSources(root)).resolves.toEqual([]);
  expect(await fs.readdir(root)).toEqual([]);
});

it('reads ordered bounded raw bytes, including old content that must not be interpreted', async () => {
  await file('002-last.yml', '${HISTORICAL_REQUIRED:?not available}');
  const first = await file();
  await file('README.md', 'ignored');
  const result = await readAppMigrationSources(root);
  expect(result.map(({ id }) => id)).toEqual(['001-first', '002-last']);
  expect(result[0]?.bytes).toEqual(await fs.readFile(first));
  expect(result[0]?.sha256).toBe(
    createHash('sha256')
      .update(await fs.readFile(first))
      .digest('hex'),
  );
  expect(result[1]?.bytes.toString()).toBe('${HISTORICAL_REQUIRED:?not available}');
  expect(Object.isFrozen(result)).toBe(true);
});

it('treats writable user app content as data without changing its ownership or permissions', async () => {
  const selected = await file();
  await fs.chmod(directory(), 0o777);
  await fs.chmod(selected, 0o666);
  const prior = await fs.stat(selected);
  await readAppMigrationSources(root);
  const after = await fs.stat(selected);
  expect([after.uid, after.gid, after.mode, after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
    prior.uid,
    prior.gid,
    prior.mode,
    prior.ino,
    prior.mtimeMs,
    prior.ctimeMs,
  ]);
});

it('refuses symlink ancestors, migration directories and files without following them', async () => {
  await file();
  const alias = path.join(root, 'alias');
  await fs.symlink(root, alias);
  await expect(readAppMigrationSources(alias)).rejects.toThrow();
  await fs.rename(directory(), path.join(root, 'original'));
  await fs.symlink('original', directory());
  await expect(readAppMigrationSources(root)).rejects.toThrow();
  await fs.unlink(directory());
  await fs.rename(path.join(root, 'original'), directory());
  await fs.symlink('001-first.yml', path.join(directory(), '002-alias.yml'));
  await expect(readAppMigrationSources(root)).rejects.toThrow('Invalid application migration file.');
});

it('refuses hardlinks and nonregular migration entries and preserves all bytes', async () => {
  const first = await file();
  const alias = path.join(directory(), '002-alias.yml');
  await fs.link(first, alias);
  await expect(readAppMigrationSources(root)).rejects.toThrow('Invalid application migration file.');
  await fs.unlink(alias);
  await fs.mkdir(alias);
  await expect(readAppMigrationSources(root)).rejects.toThrow();
  expect(await fs.readFile(first, 'utf8')).toBe('opaque historical content');
});

it('rejects unsupported extensions, invalid names and per-file or aggregate size excess', async () => {
  for (const name of ['001-old.yaml', 'Uppercase.yml', '.hidden.yml']) {
    const selected = await file(name);
    await expect(readAppMigrationSources(root)).rejects.toThrow();
    await fs.unlink(selected);
  }
  const large = await file('001-large.yml', Buffer.alloc(appMigrationFileLimit + 1));
  await expect(readAppMigrationSources(root)).rejects.toThrow();
  await fs.unlink(large);
  for (let index = 0; index < 17; index++) await file(String(index).padStart(3, '0') + '-full.yml', Buffer.alloc(appMigrationFileLimit));
  await expect(readAppMigrationSources(root)).rejects.toThrow('package is too large');
});

it('discovers historical IDs without reading their contents and loads only selected pending files', async () => {
  const historical = await file('001-historical.yml', Buffer.alloc(appMigrationFileLimit + 1));
  await fs.chmod(historical, 0);
  await file('002-pending.yml', 'selected raw content');
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('001-historical.yml')) throw new Error('Historical files must not be opened');
    return open(...args);
  });
  await expect(readAppMigrationIds(root)).resolves.toEqual(['001-historical', '002-pending']);
  const pending = await readAppMigrationSources(root, ['002-pending']);
  expect(pending.map(({ id }) => id)).toEqual(['002-pending']);
  expect(pending[0]?.bytes.toString()).toBe('selected raw content');
});

it('refuses missing or duplicate selected IDs rather than returning an incomplete pending batch', async () => {
  await file();
  await expect(readAppMigrationSources(root, ['missing'])).rejects.toThrow();
  await expect(readAppMigrationSources(root, ['001-first', '001-first'])).rejects.toThrow();
});

it('rejects an excessive number of migrations', async () => {
  for (let index = 0; index < 301; index++) await file(String(index).padStart(3, '0') + '-step.yml', 'one');
  await expect(readAppMigrationSources(root)).rejects.toThrow('too many migrations');
});

it('returns a complete snapshot when changes finish before the initial file observation', async () => {
  const selected = await file();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('001-first.yml')) await fs.writeFile(selected, 'changed bytes');
    return handle;
  });
  // The change is already present when the first file stat is taken, so its
  // complete new bytes form a snapshot; no older bytes may be returned.
  expect((await readAppMigrationSources(root))[0]?.bytes.toString()).toBe('changed bytes');
});

it('rejects an in-place change after reading bytes and before the final file observation', async () => {
  const selected = await file();
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!String(args[0]).endsWith('001-first.yml')) return handle;
    let changed = false;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'read')
          return async (...readArgs: unknown[]) => {
            const result = await Reflect.apply(target.read, target, readArgs);
            if (!changed) {
              changed = true;
              await fs.writeFile(selected, 'modified during observation');
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
  await expect(readAppMigrationSources(root)).rejects.toThrow('Invalid application migration file.');
});

it('detects a directory replacement during a file read', async () => {
  await file();
  const open = fs.open.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (!changed && String(args[0]).endsWith('001-first.yml')) {
      changed = true;
      await fs.rename(directory(), path.join(root, 'retained'));
      await fs.mkdir(directory());
      await fs.writeFile(path.join(directory(), '001-first.yml'), 'replacement');
    }
    return handle;
  });
  await expect(readAppMigrationSources(root)).rejects.toThrow();
  expect(await fs.readFile(path.join(root, 'retained/001-first.yml'), 'utf8')).toBe('opaque historical content');
});

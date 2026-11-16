import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResetState, type ResetJournal } from './reset-state';
import {
  MAX_MOUNTINFO_BYTES,
  ResetAuthorityError,
  acquireAuthorityLease,
  assertNoStrandedLegacyJournal,
  authorityJournalState,
  parseResetMounts,
  readAuthorityJournal,
  resolveResetAuthority,
  saveAuthorityJournal,
} from './reset-authority';

const journal = (overrides: Partial<Extract<ResetJournal, { version: 1 }>> = {}): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: os.hostname(),
  accounts: 'keep',
  users: [7],
  phase: 'prepared',
  createdAt: Date.now(),
  ...overrides,
});

const line = (mount: string, fsType = 'ext4', source = '/dev/sda1') => `36 35 98:0 / ${mount} rw,relatime - ${fsType} ${source} rw`;
const mountTable = (...lines: string[]) => `${lines.join('\n')}\n`;
const read = (text: string | null) => async () => text;

let root: string;
let authority: string;
let legacy: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-authority-')));
  authority = path.join(root, 'orbis-reset');
  legacy = path.join(root, 'state/orbis-reset');
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function dedicated(directory = authority) {
  const result = await resolveResetAuthority({
    dataDir: path.dirname(directory),
    name: path.basename(directory),
    readMounts: read(mountTable(line(directory))),
  });
  if (result.mode !== 'dedicated') throw new Error('Expected a mounted authority');
  return result;
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof ResetAuthorityError ? error.code : 'unexpected'),
  );

describe('mount table parsing', () => {
  it('decodes kernel mount point escapes and reads the file system type', () => {
    const mounts = parseResetMounts(mountTable(line('/data'), line('/data/orbis\\055reset', 'ext4')));
    expect(mounts).toEqual([
      { path: '/data', source: '/dev/sda1', fsType: 'ext4' },
      { path: '/data/orbis-reset', source: '/dev/sda1', fsType: 'ext4' },
    ]);
  });

  it('rejects malformed, relative and oversized mount tables instead of guessing', () => {
    for (const text of ['', '\n', 'garbage', '36 35 98:0 / /data rw,relatime', 'x 35 98:0 / /data rw - ext4 /dev/sda1 rw']) {
      expect(() => parseResetMounts(text)).toThrow(ResetAuthorityError);
    }
    expect(() => parseResetMounts('a'.repeat(MAX_MOUNTINFO_BYTES + 1))).toThrow(ResetAuthorityError);
    expect(() => parseResetMounts(mountTable(line('/data')))).not.toThrow();
  });
});

describe('authority selection', () => {
  const record = (target: string, backing: string, options = 'rw', id = 36) =>
    `${id} 35 98:0 ${backing} ${target} ${options},relatime - ext4 /dev/sda1 rw`;

  it.each(['/protected', '/protected/reset', '/protected/reset/nested'])(
    'rejects a writable bind exposing backing scope %s before writing any journal',
    async (backing) => {
      await fs.mkdir(authority, { mode: 0o700 });
      const mounts = mountTable(record(authority, '/protected/reset'), record('/other-writer', backing, 'rw', 37));
      expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mounts) }))).toBe('authority-unsafe');
      expect(await fs.readdir(authority)).toEqual([]);
    },
  );

  it('allows a read-only alias and a distinct sibling backing scope', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    const mounts = mountTable(
      record(authority, '/protected/reset'),
      record('/reader', '/protected', 'ro', 37),
      record('/sibling', '/protected/reset-other', 'rw', 38),
    );
    const capability = await resolveResetAuthority({ dataDir: root, readMounts: read(mounts) });
    if (capability.mode !== 'dedicated') throw new Error('Expected mounted authority');
    const value = journal();
    await saveAuthorityJournal(capability, value);
    expect(await readAuthorityJournal(capability)).toEqual(value);
  });

  it.each(['rw', 'ro'])('rejects a %s nested mount that could hide part of the authority', async (access) => {
    await fs.mkdir(authority, { mode: 0o700 });
    const mounts = mountTable(record(authority, '/protected/reset'), record(`${authority}/active.json`, '/foreign/file', access, 37));
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mounts) }))).toBe('authority-unsafe');
  });

  it('rejects a read-only authority mount', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(record(authority, '/protected/reset', 'ro'))) }))).toBe(
      'authority-unsafe',
    );
  });

  it('keeps the strict legacy layout when no dedicated mount exists and never creates the directory', async () => {
    const resolved = await resolveResetAuthority({
      dataDir: root,
      readMounts: read(mountTable(line('/data'))),
    });
    expect(resolved).toEqual({ mode: 'legacy', directory: legacy });
    await expect(fs.lstat(authority)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a directory that exists but is not an actual mount point', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line('/data'))) }))).toBe('not-mounted');
    expect((await fs.lstat(authority)).isDirectory()).toBe(true);
  });

  it('rejects ambiguous stacked mounts in either ordering', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    for (const lines of [
      [line(authority), line(authority, 'tmpfs')],
      [line(authority, 'tmpfs'), line(authority)],
    ]) {
      expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(...lines)) }))).toBe('authority-unsafe');
    }
  });

  it('accepts only a canonical, owner-private mount root', async () => {
    for (const mode of [0o755, 0o770, 0o777]) {
      await fs.mkdir(authority, { mode, recursive: true });
      await fs.chmod(authority, mode);
      expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) }))).toBe('authority-unsafe');
    }
    await fs.chmod(authority, 0o700);
    const resolved = await resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) });
    expect(resolved).toMatchObject({ mode: 'dedicated', directory: authority, mount: { path: authority, fsType: 'ext4' } });
  });

  it('rejects symlinked, foreign-owned and missing mount roots', async () => {
    const real = path.join(root, 'real');
    await fs.mkdir(real, { mode: 0o700 });
    await fs.symlink(real, authority);
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) }))).toBe('authority-unsafe');
    await fs.unlink(authority);
    await fs.mkdir(authority, { mode: 0o700 });
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))), uid: 54321 }))).toBe('authority-unsafe');
    await fs.rm(authority, { recursive: true });
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) }))).toBe('authority-unsafe');
  });

  it('rejects ephemeral mounts that would lose the journal on restart', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    for (const fsType of ['tmpfs', 'overlay', 'ramfs', 'nsfs']) {
      expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority, fsType))) }))).toBe('ephemeral-mount');
    }
  });

  it('fails closed when this process has no mount namespace information', async () => {
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(null) }))).toBe('mounts-unavailable');
  });

  it('refuses to hide an unfinished legacy journal when the dedicated authority appears', async () => {
    const pending = journal({ phase: 'preferences' });
    await new ResetState(root).save(pending);
    await fs.mkdir(authority, { mode: 0o700 });
    const error = await resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ResetAuthorityError);
    expect(error).toMatchObject({ code: 'legacy-journal', detail: { reason: 'preferences', journal: pending.id } });
  });

  it('allows migration after a completed legacy journal but not while its recovery lock survives', async () => {
    await new ResetState(root).save(journal({ phase: 'complete' }));
    const release = await new ResetState(root).acquireLease();
    await fs.mkdir(authority, { mode: 0o700 });
    expect(await code(resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) }))).toBe('legacy-journal');
    await release();
    expect(await resolveResetAuthority({ dataDir: root, readMounts: read(mountTable(line(authority))) })).toMatchObject({ mode: 'dedicated' });
  });

  it('fails closed on legacy staging residue, orphan locks and unreadable legacy journals', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    const options = { dataDir: root, readMounts: read(mountTable(line(authority))) };
    await fs.mkdir(path.join(legacy, randomUUID()), { recursive: true, mode: 0o700 });
    expect(await code(resolveResetAuthority(options))).toBe('legacy-journal');
    await fs.rm(legacy, { recursive: true });
    await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(legacy, 'operation.lock'), '{}\n', { mode: 0o600 });
    expect(await code(resolveResetAuthority(options))).toBe('legacy-journal');
    await fs.rm(legacy, { recursive: true });
    await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(legacy, 'active.json'), '{}\n', { mode: 0o600 });
    expect(await code(resolveResetAuthority(options))).toBe('journal-invalid');
  });

  it('never follows a symbolic link when the legacy journal is inspected', async () => {
    await fs.mkdir(authority, { mode: 0o700 });
    const outside = path.join(root, 'outside.json');
    await fs.writeFile(outside, `${JSON.stringify(journal())}\n`, { mode: 0o600 });
    await fs.mkdir(legacy, { recursive: true, mode: 0o700 });
    await fs.symlink(outside, path.join(legacy, 'active.json'));
    expect(await code(assertNoStrandedLegacyJournal(root))).toBe('journal-unsafe');
  });

  it('rejects a symlinked legacy directory and symlinked state ancestor', async () => {
    await fs.mkdir(path.join(root, 'outside'), { mode: 0o700 });
    await fs.mkdir(path.dirname(legacy), { mode: 0o700 });
    await fs.symlink(path.join(root, 'outside'), legacy);
    expect(await code(assertNoStrandedLegacyJournal(root))).toBe('journal-unsafe');
    await fs.unlink(legacy);
    await fs.rmdir(path.dirname(legacy));
    await fs.mkdir(path.join(root, 'outside/orbis-reset'), { mode: 0o700 });
    await fs.symlink(path.join(root, 'outside'), path.dirname(legacy));
    expect(await code(assertNoStrandedLegacyJournal(root))).toBe('journal-unsafe');
  });

  it('accepts the empty current staging directory left by a completed legacy reset', async () => {
    const complete = journal({ phase: 'complete' });
    await new ResetState(root).save(complete);
    const stage = path.join(legacy, complete.id);
    await fs.mkdir(stage, { mode: 0o700 });
    await expect(assertNoStrandedLegacyJournal(root)).resolves.toBeUndefined();
    await fs.writeFile(path.join(stage, 'unexpected'), 'preserve');
    expect(await code(assertNoStrandedLegacyJournal(root))).toBe('legacy-journal');
    expect(await fs.readFile(path.join(stage, 'unexpected'), 'utf8')).toBe('preserve');
  });
});

describe('dedicated journal', () => {
  beforeEach(async () => {
    await fs.mkdir(authority, { mode: 0o700 });
  });

  it.each(['mount-id', 'backing-root', 'device', 'source'])(
    'rejects %s drift behind an admitted authority before reading, writing or taking a lease',
    async (kind) => {
      let mounts = mountTable(line(authority));
      const capability = await resolveResetAuthority({ dataDir: root, readMounts: async () => mounts });
      if (capability.mode !== 'dedicated') throw new Error('Expected mounted authority');
      mounts = mountTable(
        line(authority).replace(
          kind === 'mount-id' ? '36 35' : kind === 'backing-root' ? '98:0 / ' : kind === 'device' ? '98:0' : '/dev/sda1',
          kind === 'mount-id' ? '37 35' : kind === 'backing-root' ? '98:0 /replacement ' : kind === 'device' ? '99:0' : '/dev/sdb1',
        ),
      );
      for (const operation of [
        () => readAuthorityJournal(capability),
        () => saveAuthorityJournal(capability, journal()),
        () => acquireAuthorityLease(capability),
      ])
        expect(await code(operation())).toBe('authority-unsafe');
      expect(await fs.readdir(authority)).toEqual([]);
    },
  );

  it('refuses a replaced private root while preserving the prior journal and replacement contents', async () => {
    const capability = await dedicated();
    const saved = journal();
    await saveAuthorityJournal(capability, saved);
    await fs.rename(authority, `${authority}-original`);
    await fs.mkdir(authority, { mode: 0o700 });
    await fs.writeFile(path.join(authority, 'canary'), 'keep replacement', { mode: 0o600 });
    expect(await code(saveAuthorityJournal(capability, journal()))).toBe('authority-unsafe');
    expect(await fs.readFile(path.join(authority, 'canary'), 'utf8')).toBe('keep replacement');
    expect(JSON.parse(await fs.readFile(path.join(`${authority}-original`, 'active.json'), 'utf8'))).toEqual(saved);
  });

  it('withholds journal publication after mount identity changes during its staged write', async () => {
    let mounts = mountTable(line(authority));
    const capability = await resolveResetAuthority({ dataDir: root, readMounts: async () => mounts });
    if (capability.mode !== 'dedicated') throw new Error('Expected mounted authority');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('/.journal-')) mounts = mountTable(line(authority).replace('36 35', '37 35'));
      return handle;
    });
    expect(await code(saveAuthorityJournal(capability, journal()))).toBe('authority-unsafe');
    expect(await fs.readdir(authority)).toEqual([]);
  });

  it('preserves a held lock when a writable alias appears before release', async () => {
    let mounts = mountTable(line(authority));
    const capability = await resolveResetAuthority({ dataDir: root, readMounts: async () => mounts });
    if (capability.mode !== 'dedicated') throw new Error('Expected mounted authority');
    const release = await acquireAuthorityLease(capability);
    mounts = mountTable(line(authority), line('/other-writer'));
    expect(await code(release())).toBe('authority-unsafe');
    expect((await fs.lstat(path.join(authority, 'operation.lock'))).isFile()).toBe(true);
  });

  it('keeps an orphan lock from being reported as an absent journal', async () => {
    const capability = await dedicated();
    const release = await acquireAuthorityLease(capability);
    expect(await code(authorityJournalState(capability))).toBe('journal-unsafe');
    expect(await code(readAuthorityJournal(capability))).toBe('journal-unsafe');
    await release();
    expect(await authorityJournalState(capability)).toEqual({ journal: null, state: 'absent' });
  });

  it('preserves a foreign replacement for its unpublished journal staging file', async () => {
    const capability = await dedicated();
    const open = fs.open.bind(fs);
    let replacement = '';
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).includes('/.journal-')) {
        replacement = String(args[0]);
        await fs.unlink(replacement);
        await fs.writeFile(replacement, 'keep foreign staging', { mode: 0o600 });
      }
      return handle;
    });
    expect(await code(saveAuthorityJournal(capability, journal()))).toBe('journal-unsafe');
    expect(await fs.readFile(path.join(authority, path.basename(replacement)), 'utf8')).toBe('keep foreign staging');
    await expect(fs.lstat(path.join(authority, 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['active.json', 'operation.lock'])('rejects a non-regular %s without blocking on a FIFO', async (name) => {
    const capability = await dedicated();
    await promisify(execFile)('mkfifo', ['-m', '600', path.join(authority, name)]);
    expect(await code(authorityJournalState(capability))).toBe('journal-unsafe');
  });

  it('rejects unverified private directories and rechecks a resolved mount before writes', async () => {
    expect(await code(saveAuthorityJournal(authority as never, journal()))).toBe('authority-unsafe');
    let mounts = mountTable(line(authority));
    const capability = await resolveResetAuthority({ dataDir: root, readMounts: async () => mounts });
    if (capability.mode !== 'dedicated') throw new Error('Expected mounted authority');
    mounts = mountTable(line('/data'));
    expect(await code(saveAuthorityJournal(capability, journal()))).toBe('not-mounted');
    await expect(fs.lstat(path.join(authority, 'active.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips a private journal and reports a pending hold for imported intent', async () => {
    expect(await readAuthorityJournal(await dedicated())).toBeNull();
    const imported = journal({ controller: 'another-controller', phase: 'recovery' });
    await saveAuthorityJournal(await dedicated(), imported);
    expect(await readAuthorityJournal(await dedicated())).toEqual(imported);
    expect(await authorityJournalState(await dedicated())).toEqual({ journal: imported, state: 'pending' });
    const stat = await fs.lstat(path.join(authority, 'active.json'));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.readdir(authority)).filter((name) => name.startsWith('.journal-'))).toEqual([]);
  });

  it('maps a completed journal with a surviving lease to recovery', async () => {
    const complete = journal({ phase: 'complete' });
    await saveAuthorityJournal(await dedicated(), complete);
    expect(await authorityJournalState(await dedicated())).toEqual({ journal: complete, state: 'complete' });
    const release = await acquireAuthorityLease(await dedicated());
    expect(await authorityJournalState(await dedicated())).toEqual({ journal: { ...complete, phase: 'recovery' }, state: 'recovery' });
    await release();
    expect((await authorityJournalState(await dedicated())).state).toBe('complete');
  });

  it('never creates the authority directory and rejects a shared directory', async () => {
    const missing = path.join(root, 'missing');
    expect(await code(saveAuthorityJournal(missing as never, journal()))).toBe('authority-unsafe');
    await expect(fs.lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    const capability = await dedicated();
    await fs.chmod(authority, 0o777);
    expect(await code(saveAuthorityJournal(capability, journal()))).toBe('authority-unsafe');
  });

  it('rejects hard-linked, oversized, symlinked and malformed journal files', async () => {
    await saveAuthorityJournal(await dedicated(), journal());
    await fs.link(path.join(authority, 'active.json'), path.join(authority, 'copy'));
    expect(await code(readAuthorityJournal(await dedicated()))).toBe('journal-unsafe');
    await fs.unlink(path.join(authority, 'copy'));

    await fs.writeFile(path.join(authority, 'active.json'), 'x'.repeat(17_000), { mode: 0o600 });
    expect(await code(readAuthorityJournal(await dedicated()))).toBe('journal-unsafe');

    const outside = path.join(root, 'journal.json');
    await fs.writeFile(outside, `${JSON.stringify(journal())}\n`, { mode: 0o600 });
    await fs.unlink(path.join(authority, 'active.json'));
    await fs.symlink(outside, path.join(authority, 'active.json'));
    expect(await code(readAuthorityJournal(await dedicated()))).toBe('journal-unsafe');

    await fs.unlink(path.join(authority, 'active.json'));
    await fs.writeFile(path.join(authority, 'active.json'), '{}\n', { mode: 0o600 });
    expect(await code(readAuthorityJournal(await dedicated()))).toBe('journal-invalid');
    await expect(saveAuthorityJournal(await dedicated(), { ...journal(), version: 2 } as never)).rejects.toThrow();
  });

  it('keeps an exclusive lease and refuses to release a replaced lock file', async () => {
    const release = await acquireAuthorityLease(await dedicated());
    await expect(acquireAuthorityLease(await dedicated())).rejects.toMatchObject({ code: 'journal-unsafe' });
    await fs.unlink(path.join(authority, 'operation.lock'));
    await fs.writeFile(path.join(authority, 'operation.lock'), '{}\n', { mode: 0o600 });
    await expect(release()).rejects.toMatchObject({ code: 'journal-unsafe' });
    await fs.unlink(path.join(authority, 'operation.lock'));
    const next = await acquireAuthorityLease(await dedicated());
    await next();
  });
});

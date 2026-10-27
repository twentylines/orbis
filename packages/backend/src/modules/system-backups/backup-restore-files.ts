import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { BackupRequirementError } from './backup-files';
import { backupMemberName } from './backup-import';
import { BackupDatabaseLines } from './backup-docker-exec';

const failed = () => new BackupRequirementError('Restored files no longer match the approved backup. Keep apps stopped and retry recovery.');
const metadata = type({
  root: 'string',
  name: 'string',
  kind: "'file' | 'directory'",
  uid: 'number.integer >= 0 & number <= 4294967295',
  gid: 'number.integer >= 0 & number <= 4294967295',
  mode: 'number.integer >= 0 & number <= 511',
  mtime: 'number',
  'bytes?': 'number.integer >= 0',
  'sha256?': type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value)),
}).onUndeclaredKey('reject');
export type RestoreFileReview = { bytes: number; sha256: string; files: number; directories: number };

export async function verifyRestoreFiles(options: {
  ledger: string;
  expected: RestoreFileReview;
  roots: Record<string, string>;
  signal: AbortSignal;
}) {
  const { expected, signal } = options;
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    expected.bytes > 64 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.files) ||
    expected.files < 0 ||
    !Number.isSafeInteger(expected.directories) ||
    expected.directories < 0 ||
    expected.files + expected.directories > 250_000
  )
    throw failed();
  for (const target of Object.values(options.roots)) {
    if (!path.isAbsolute(target) || (await fs.realpath(target)) !== target || !(await fs.lstat(target)).isDirectory()) throw failed();
  }
  const source = await fs.open(options.ledger, constants.O_RDONLY | constants.O_NOFOLLOW);
  const names = new Set<string>();
  let files = 0;
  let directories = 0;
  let pathBytes = 0;
  try {
    const before = await source.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size !== expected.bytes ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw failed();
    const digest = createHash('sha256');
    const lines = new BackupDatabaseLines({ rowBytes: 16 * 1024, totalBytes: 64 * 1024 * 1024, rows: 250_000 }, async (value) => {
      signal.throwIfAborted();
      const entry = metadata(value);
      if (
        entry instanceof type.errors ||
        !Object.hasOwn(options.roots, entry.root) ||
        !Number.isFinite(entry.mtime) ||
        backupMemberName(entry.name) !== entry.name ||
        entry.name === '.' ||
        entry.name.split('/')[0]?.startsWith('.orbis-restore-')
      )
        throw failed();
      if (
        (entry.kind === 'file' && (entry.bytes === undefined || entry.sha256 === undefined)) ||
        (entry.kind === 'directory' && (entry.bytes !== undefined || entry.sha256 !== undefined))
      )
        throw failed();
      const key = `${entry.root}/${entry.name}`;
      pathBytes += Buffer.byteLength(key);
      if (names.has(key) || pathBytes > 32 * 1024 * 1024) throw failed();
      names.add(key);
      const target = path.join(options.roots[entry.root] as string, entry.name);
      if ((await fs.realpath(target)) !== target) throw failed();
      const stat = await fs.lstat(target);
      if (
        stat.uid !== entry.uid ||
        stat.gid !== entry.gid ||
        (stat.mode & 0o777) !== entry.mode ||
        Math.abs(stat.mtimeMs - entry.mtime) > 1 ||
        stat.isSymbolicLink()
      )
        throw failed();
      if (entry.kind === 'directory') {
        if (!stat.isDirectory()) throw failed();
        directories++;
      } else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.bytes) throw failed();
        const file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await file.stat();
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.ctimeMs !== stat.ctimeMs) throw failed();
          const digest = createHash('sha256');
          for await (const chunk of file.createReadStream({ autoClose: false })) {
            signal.throwIfAborted();
            digest.update(chunk);
          }
          const after = await file.stat();
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || digest.digest('hex') !== entry.sha256)
            throw failed();
        } finally {
          await file.close();
        }
        files++;
      }
    });
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      signal.throwIfAborted();
      digest.update(chunk);
      await lines.write(chunk);
    }
    lines.finish();
    const after = await source.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      digest.digest('hex') !== expected.sha256 ||
      files !== expected.files ||
      directories !== expected.directories
    )
      throw failed();
    const visit = async (root: string, directory: string, name: string) => {
      for (const child of await fs.readdir(directory)) {
        signal.throwIfAborted();
        if (!name && child.startsWith('.orbis-restore-')) continue;
        const relative = name ? `${name}/${child}` : child;
        if (!names.delete(`${root}/${relative}`)) throw failed();
        const stat = await fs.lstat(path.join(directory, child));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw failed();
        if (stat.isDirectory()) await visit(root, path.join(directory, child), relative);
      }
    };
    for (const [root, target] of Object.entries(options.roots)) await visit(root, target, '');
    if (names.size) throw failed();
  } finally {
    await source.close();
  }
}

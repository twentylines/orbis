import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readAppVolumePins } from './app-volume-pins';

const schema = 'orbis.app-volume-authority.v1';
const fail = () => new Error('App storage protection is not ready. Your saved data has not been changed.');
const ephemeral = new Set(['tmpfs', 'ramfs', 'overlay', 'aufs', 'proc', 'sysfs', 'devtmpfs', 'cgroup', 'cgroup2']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const decodeMountPath = (value: string) => value.replace(/\\(040|011|012|134)/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 8)));
async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function marker(directory: string) {
  const file = path.join(directory, 'authority.json');
  const input = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 256 * 1024 ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    const bytes = await input.readFile();
    const after = await input.stat();
    const named = await fs.lstat(file);
    for (const current of [after, named])
      for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'ctimeMs', 'mtimeMs'] as const)
        if (current[key] !== before[key]) throw fail();
    if (bytes.length !== before.size) throw fail();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !record(value) ||
      Object.keys(value).sort().join(',') !== 'files,generation,schema,version' ||
      value.schema !== schema ||
      value.version !== 1 ||
      typeof value.generation !== 'string' ||
      !uuid.test(value.generation) ||
      !record(value.files) ||
      Object.keys(value.files).length > 1024
    )
      throw fail();
    for (const [name, hash] of Object.entries(value.files))
      if (!/^[a-f0-9]{64}\.json$/.test(name) || typeof hash !== 'string' || !digest.test(hash)) throw fail();
    return { files: value.files as Record<string, string>, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await input.close();
  }
}

// The optional observation is a code-owned filesystem test seam, never request data.
export async function readAppVolumeAuthority(
  dataDir: string,
  identity: { appUrn: string; project: string },
  observation?: { mountInfo: string; requirement?: string },
) {
  try {
    if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw fail();
    const requirement = observation ? observation.requirement : process.env.ORBIS_APP_VOLUME_AUTHORITY;
    if (requirement !== undefined && requirement !== 'none' && requirement !== schema) throw fail();
    if (await exists(path.join(dataDir, 'state', 'app-volume-pins'))) throw fail();
    const root = path.join(dataDir, 'orbis-volumes');
    const present = await exists(root);
    if (!observation && process.platform !== 'linux') {
      if (present || requirement === schema) throw fail();
      return null;
    }
    const body = observation?.mountInfo ?? (await fs.readFile('/proc/self/mountinfo', 'utf8'));
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw fail();
    const mounts = body
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const columns = line.split(' ');
        const separator = columns.indexOf('-');
        if (separator < 6 || columns.length < separator + 4) throw fail();
        return { target: decodeMountPath(columns[4] ?? ''), options: columns[5]?.split(',') ?? [], filesystem: columns[separator + 1] ?? '' };
      });
    const selected = mounts.filter((mount) => mount.target === root);
    if (!selected.length) {
      if (present || requirement === schema) throw fail();
      return null;
    }
    if (
      selected.length !== 1 ||
      !present ||
      requirement === 'none' ||
      !selected[0]?.options.includes('ro') ||
      ephemeral.has(selected[0].filesystem) ||
      mounts.some((mount) => mount.target.startsWith(`${root}/`))
    )
      throw fail();
    for (const directory of [dataDir, root]) {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory ||
        stat.mode & (directory === root ? 0o077 : 0o022) ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw fail();
    }
    const before = await marker(root);
    const name = `${createHash('sha256').update(identity.appUrn).digest('hex')}.json`;
    const expected = before.files[name];
    const pins = await readAppVolumePins(path.join(root, 'pins'), identity);
    if (pins ? expected !== pins.sha256 : expected !== undefined) throw fail();
    if ((await marker(root)).sha256 !== before.sha256) throw fail();
    return pins;
  } catch {
    throw fail();
  }
}

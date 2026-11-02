import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timeMachineIdSchema, timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import {
  canonicalPublicationJson,
  copyControllerPublicationExpectation,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from '../host-updates/host-controller-publication';
import { privateBackupDirectory } from './backup-files';

const limit = 8 * 1024 * 1024;
const keyPattern = /^[a-f0-9]{64}$/;
const same = (a: Awaited<ReturnType<fs.FileHandle['stat']>>, b: Awaited<ReturnType<fs.FileHandle['stat']>>) =>
  ['ino', 'dev', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const invalid = () => new Error('Private capture fence recovery requires review.');

export class CaptureFenceAttempt {
  constructor(
    readonly expected: ControllerPublicationExpectation,
    readonly receipt: ControllerPublicationReceipt,
    readonly clientKey: string,
    readonly bytes: Buffer,
  ) {
    Object.freeze(this);
  }
  toJSON(): never {
    throw invalid();
  }
}

export class CaptureFenceJournal {
  readonly directory: string;
  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, 'backups', 'time-machine', 'capture-fences');
  }
  private file(id: string) {
    if (!timeMachineIdSchema.allows(id)) throw invalid();
    return path.join(this.directory, `${id}.json`);
  }
  private async sync() {
    const directory = await fs.open(this.directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private decode(bytes: Buffer, id: string) {
    if (!bytes.length || bytes.length > limit) throw invalid();
    const value = JSON.parse(bytes.toString());
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'clientKey,expected,receipt,schema' ||
      value.schema !== 'orbis.capture-fence-attempt.v1' ||
      typeof value.clientKey !== 'string' ||
      !keyPattern.test(value.clientKey) ||
      typeof value.receipt !== 'string' ||
      !bytes.equals(Buffer.from(canonicalPublicationJson(value)))
    )
      throw invalid();
    const expected = copyControllerPublicationExpectation(value.expected);
    if (expected.configuration.pointId !== id) throw invalid();
    const raw = Buffer.from(value.receipt, 'base64');
    if (raw.toString('base64') !== value.receipt) throw invalid();
    const receipt = decodeControllerPublicationReceipt(parseControllerPublicationResponse(raw), expected);
    return new CaptureFenceAttempt(expected, receipt, value.clientKey, Buffer.from(bytes));
  }
  private async read(file: string, id: string) {
    if ((await fs.realpath(this.directory)) !== path.resolve(this.directory)) throw invalid();
    const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.size > limit || (process.getuid && before.uid !== process.getuid()))
        throw invalid();
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) throw invalid();
        offset += part.bytesRead;
      }
      if (!same(before, await handle.stat()) || !same(before, await fs.lstat(file))) throw invalid();
      return this.decode(bytes, id);
    } finally {
      await handle.close();
    }
  }
  async create(expected: ControllerPublicationExpectation, receipt: ControllerPublicationReceipt) {
    await privateBackupDirectory(this.directory);
    const id = expected.configuration.pointId;
    const file = this.file(id);
    const key = randomBytes(32).toString('hex');
    const body = Buffer.from(
      canonicalPublicationJson({
        schema: 'orbis.capture-fence-attempt.v1',
        expected: copyControllerPublicationExpectation(expected),
        receipt: receipt.read().toString('base64'),
        clientKey: key,
      }),
    );
    const attempt = this.decode(body, id);
    if (
      await fs.lstat(file).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      )
    )
      throw invalid();
    const temporary = path.join(this.directory, `.${id}.${randomBytes(16).toString('hex')}.pending`);
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      await fs.unlink(temporary);
      throw error;
    }
    await fs.unlink(temporary);
    await this.sync();
    return attempt;
  }
  async list() {
    try {
      await fs.lstat(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    await privateBackupDirectory(this.directory);
    const names = await fs.readdir(this.directory);
    if (names.length > timeMachineLimits.points * 2) throw invalid();
    const result: CaptureFenceAttempt[] = [];
    for (const name of names.sort()) {
      const pending = /^\.([a-f0-9-]{36})\.[a-f0-9]{32}\.pending$/.exec(name);
      if (pending && timeMachineIdSchema.allows(pending[1])) {
        const file = path.join(this.directory, name);
        const stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          ![1, 2].includes(stat.nlink) ||
          stat.mode & 0o077 ||
          stat.size > limit ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw invalid();
        if (stat.nlink === 2) {
          const canonical = await fs.lstat(this.file(pending[1] ?? ''));
          if (canonical.ino !== stat.ino || canonical.dev !== stat.dev || canonical.nlink !== 2) throw invalid();
        }
        // Acquisition starts only after the canonical journal link and directory sync have completed.
        await fs.unlink(file);
        await this.sync();
        continue;
      }
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      result.push(await this.read(this.file(id), id));
    }
    return result;
  }
  async remove(attempt: CaptureFenceAttempt) {
    const id = attempt.expected.configuration.pointId;
    const current = await this.read(this.file(id), id);
    if (!current.bytes.equals(attempt.bytes)) throw invalid();
    await fs.unlink(this.file(id));
    await this.sync();
  }
}

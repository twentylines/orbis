import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import {
  isStableOrbisReleaseTag,
  orbisReleaseChannelStatus,
  type OrbisReleaseChannel,
  type OrbisReleaseChannelStatus,
} from '@runtipi/common/schemas/orbis-release-channel';

export type StoredReleaseChannel = { version: 1; channel: OrbisReleaseChannel; revision: string };
const invalid = () =>
  new ServiceUnavailableException({
    code: 'channel-storage-invalid',
    message: 'The private update-channel settings could not be verified. Use the Orbis installer to review this server’s update setup.',
  });

async function channelFile(state: string) {
  const parent = await fs.lstat(state);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (await fs.realpath(state)) !== state) throw invalid();
  const directory = path.join(state, 'orbis-update-policy');
  const file = path.join(directory, 'channel.json');
  try {
    const policy = await fs.lstat(directory);
    if (
      !policy.isDirectory() ||
      policy.isSymbolicLink() ||
      policy.mode & 0o077 ||
      (process.getuid && policy.uid !== process.getuid()) ||
      (await fs.realpath(directory)) !== directory
    )
      throw invalid();
    await fs.lstat(file);
    return file;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const legacy = path.join(state, 'orbis-release-channel.json');
  try {
    await fs.lstat(legacy);
    if (parent.mode & 0o022) throw invalid();
    return legacy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return file;
}

@Injectable()
export class OrbisReleaseChannelsService {
  constructor(private readonly config: ConfigurationService) {}

  async read(): Promise<StoredReleaseChannel> {
    const directory = path.join(this.config.get('directories').dataDir, 'state');
    let handle: FileHandle | undefined;
    try {
      const file = await channelFile(directory);
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > 4096 || before.mode & 0o077 || (process.getuid && before.uid !== process.getuid()))
        throw invalid();
      const data: unknown = JSON.parse(await handle.readFile('utf8'));
      const after = await handle.stat();
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
        throw invalid();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
      const record = data as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(',') !== 'channel,revision,version' ||
        record.version !== 1 ||
        typeof record.channel !== 'string' ||
        !['stable', 'nightly'].includes(record.channel) ||
        typeof record.revision !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.revision)
      )
        throw invalid();
      return record as StoredReleaseChannel;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, channel: 'stable', revision: 'initial' };
      throw invalid();
    } finally {
      await handle?.close();
    }
  }

  async status(): Promise<OrbisReleaseChannelStatus> {
    const record = await this.read();
    const installedVersion = process.env.ORBIS_VERSION || null;
    return {
      ...orbisReleaseChannelStatus,
      current: record.channel,
      revision: record.revision,
      installedVersion,
      requiresStableInstall: record.channel === 'nightly' && (!installedVersion || !isStableOrbisReleaseTag(installedVersion)),
    };
  }
}

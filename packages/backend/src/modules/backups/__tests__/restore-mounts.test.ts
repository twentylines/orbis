import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertNoRestoreMounts, parseRestoreMounts } from '../restore-mounts';

const line = (mount: string) => `24 1 8:1 / ${mount} rw,relatime - ext4 /dev/disk rw\n`;

describe('Restore mount boundaries', () => {
  it('decodes kernel mount paths containing escaped spaces and backslashes', () => {
    expect(parseRestoreMounts(line('/data/space\\040name\\134folder'))).toEqual(['/data/space name\\folder']);
  });

  it.each(['/tmp/restore-mounts/live', '/tmp/restore-mounts/live/nested', '/tmp/restore-mounts/live/..mounted'])(
    'rejects a mount at %s, including same-device bind mounts',
    async (mount) => {
      await fs.promises.mkdir('/tmp/restore-mounts/live', { recursive: true });
      await expect(assertNoRestoreMounts('/tmp/restore-mounts/live', async () => line(mount))).rejects.toThrow('contains a mount point');
    },
  );

  it('allows ancestor mounts and siblings with a similar prefix', async () => {
    await fs.promises.mkdir('/tmp/restore-mounts/live', { recursive: true });
    await expect(
      assertNoRestoreMounts('/tmp/restore-mounts/live', async () => line('/tmp') + line('/tmp/restore-mounts/live-other')),
    ).resolves.toBeUndefined();
  });

  it('refuses to infer safe mount boundaries from missing or malformed data', async () => {
    await fs.promises.mkdir('/tmp/restore-mounts/live', { recursive: true });
    await expect(assertNoRestoreMounts('/tmp/restore-mounts/live', async () => '')).rejects.toThrow('could not be inspected');
    await expect(assertNoRestoreMounts('/tmp/restore-mounts/live', async () => 'invalid mount row')).rejects.toThrow('could not be inspected');
  });
});

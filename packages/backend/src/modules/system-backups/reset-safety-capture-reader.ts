import fs from 'node:fs/promises';
import { createBackupCiphertextSequenceInspector } from './backup-crypto';
import { inspectResetCaptureRecoveryMetadata, validateResetCaptureRecoveryManifest } from './reset-capture-recovery-manifest';
import { sealedBundleFiles } from './settings-backup-format';

const fail = () => new Error('The complete reset capture contents could not be verified. Keep the archive and encrypted staging for review.');

/** Checks ordered raw members while the outer archive reader retains at most one encrypted chunk. */
export function resetSafetyCaptureReader(options: { manifest: unknown; passphrase: string; signal: AbortSignal }) {
  const manifest = validateResetCaptureRecoveryManifest(options.manifest);
  const { passphrase, signal } = options;
  const members = manifest.entries.flatMap((item) =>
    item.type === 'file' ? item.chunks.map((chunk, at) => ({ item, chunk, last: at === item.chunks.length - 1 })) : [],
  );
  const byName = new Set(members.map(({ chunk }) => `parts/${chunk.part}`));
  let position = 0;
  let pending = false;
  let closed = false;
  let sequence: ReturnType<typeof createBackupCiphertextSequenceInspector> | undefined;
  return {
    has: (name: string) => byName.has(name),
    async inspect(name: string, source: string) {
      if (pending || closed) {
        closed = true;
        throw fail();
      }
      pending = true;
      try {
        signal.throwIfAborted();
        const member = members[position];
        if (!member || name !== `parts/${member.chunk.part}`) throw fail();
        const before = sealedBundleFiles.seal(await fs.lstat(source));
        const measured = await sealedBundleFiles.measure(source, signal, member.chunk.bytes);
        if (measured.bytes !== member.chunk.bytes || measured.sha256 !== member.chunk.sha256) throw fail();
        if (member.chunk.offset === 0) {
          if (sequence) throw fail();
          sequence = createBackupCiphertextSequenceInspector({ passphrase, signal });
        }
        if (!sequence) throw fail();
        const chunk = await sequence.add({ source, plaintextBytes: member.chunk.plaintextBytes });
        if (chunk.plaintextSha256 !== member.chunk.plaintextSha256) throw fail();
        if (member.last) {
          const file = sequence.finish();
          sequence = undefined;
          if (file.plaintextBytes !== member.item.plaintextBytes || file.plaintextSha256 !== member.item.plaintextSha256) throw fail();
          await inspectResetCaptureRecoveryMetadata({ manifest, item: member.item, source, passphrase, signal });
        }
        if (closed || before !== sealedBundleFiles.seal(await fs.lstat(source))) throw fail();
        signal.throwIfAborted();
        position++;
        return Object.freeze({ name: member.item.name, offset: member.chunk.offset, plaintextBytes: member.chunk.plaintextBytes });
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        pending = false;
      }
    },
    finish() {
      if (closed || pending || sequence || position !== members.length) {
        closed = true;
        throw fail();
      }
      closed = true;
      signal.throwIfAborted();
      return manifest;
    },
  };
}

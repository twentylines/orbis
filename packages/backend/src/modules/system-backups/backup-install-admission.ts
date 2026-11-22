import path from 'node:path';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { hasInstallRequestHold, installRequestDirectory } from '../app-lifecycle/install-request-receipt';
import { BackupRequirementError } from './backup-files';
import type { FullBackupManifest } from './backup-import';

function projectUrns(project: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(project)) return [];
  // Legacy runtime records carry a Compose project only. Names and stores can
  // both contain underscores, so every possible URN must be clear.
  return [...project.matchAll(/_/g)]
    .filter(({ index }) => index !== 0 && index !== project.length - 1)
    .map(({ index }) => createAppUrn(project.slice(0, index), project.slice(index + 1)));
}

export async function requireArchivedBackupInstallHoldsClear(dataDir: string, projects: Iterable<string>, manifest: FullBackupManifest) {
  const unique = new Set(projects);
  const metadata = new Map<string, FullBackupManifest['directories'][number]>();
  const aliases = new Set<string>();
  for (const entry of manifest.directories) {
    const name = entry.name.toLowerCase();
    if (name !== entry.name || metadata.has(name)) aliases.add(name);
    metadata.set(name, entry);
  }
  for (const project of unique) {
    for (const urn of projectUrns(project)) {
      const receipt = `data/${path.relative(dataDir, installRequestDirectory(dataDir, urn)).split(path.sep).join('/')}`;
      // Extraction uses private scratch permissions. Check the archived values
      // that materialization will apply before approving any restart intent.
      for (const name of [path.posix.dirname(receipt), receipt]) {
        const entry = metadata.get(name);
        if (aliases.has(name) || (entry && (entry.mode & 0o077 || (process.geteuid && entry.uid !== process.geteuid()))))
          throw new BackupRequirementError('App install recovery storage could not be verified.');
      }
    }
  }
  await requireBackupInstallHoldsClear(dataDir, unique, 'archive');
}

export async function requireBackupInstallHoldsClear(dataDir: string, projects: Iterable<string>, source: 'live' | 'archive') {
  for (const project of new Set(projects)) {
    for (const urn of projectUrns(project)) {
      let held: boolean;
      try {
        held = await hasInstallRequestHold(dataDir, urn);
      } catch {
        throw new BackupRequirementError('App install recovery storage could not be verified.');
      }
      if (held)
        throw new BackupRequirementError(
          source === 'live'
            ? 'An app scheduled to restart has unfinished install recovery. Review the app install before retrying.'
            : 'This backup would start an app with unfinished install recovery. Choose a backup where the app was stopped.',
        );
    }
  }
}

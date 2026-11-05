import { setSettingsRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { SettingsBackupTransaction } from './settings-backup-transaction';

export async function settingsRestoreRequiresRecovery(dataDir: string) {
  try {
    const transaction = await SettingsBackupTransaction.active(dataDir);
    return Boolean(transaction && !['complete', 'rolled-back'].includes(transaction.state.phase));
  } catch {
    return true;
  }
}

export async function prepareSettingsRestoreEnvironment(dataDir: string, generate: () => Promise<unknown>) {
  const required = await settingsRestoreRequiresRecovery(dataDir);
  setSettingsRestoreRecoveryRequired(required);
  // The existing connection environment remains usable while the settings file may be only partly restored.
  if (!required) await generate();
  return required;
}

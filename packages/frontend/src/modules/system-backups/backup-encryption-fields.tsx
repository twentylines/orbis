import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox/Checkbox';
import './backup-encryption-fields.css';

export function backupEncryptionPassphrase(values: FormData, kind: 'export' | 'review', useAccountPassword: boolean): string {
  const account = kind === 'export' && useAccountPassword;
  const passphrase = String(values.get(account ? 'password' : 'passphrase') ?? '');
  if (passphrase.length < 8 || !passphrase.trim() || passphrase.length > 1024) {
    throw new Error(
      account
        ? 'Your account password must be between 8 and 1024 characters to encrypt a backup. Choose a separate backup passphrase instead.'
        : 'Use a backup password or passphrase between 8 and 1024 characters.',
    );
  }
  if (kind === 'export' && !account && passphrase !== String(values.get('repeatPassphrase') ?? '')) {
    throw new Error('The backup passphrases did not match. Enter them again.');
  }
  return passphrase;
}

export function BackupEncryptionFields({
  useAccountPassword,
  disabled,
  onChange,
  id,
}: {
  useAccountPassword: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
  id: string;
}) {
  return (
    <div className="system-backups-encryption">
      <Checkbox checked={useAccountPassword} disabled={disabled} onCheckedChange={onChange} label="Use my account password to encrypt this backup" />
      <p>
        {useAccountPassword
          ? 'Open this backup with the account password you use today. Changing your account password later won’t change this backup.'
          : 'Keep this passphrase with your recovery records. It cannot be recovered if lost.'}
      </p>
      {useAccountPassword ? null : (
        <div className="system-backups-fields">
          <Input
            name="passphrase"
            id={`${id}-passphrase`}
            label="New backup passphrase"
            type="password"
            autoComplete="off"
            minLength={8}
            maxLength={1024}
            required
            disabled={disabled}
          />
          <Input
            name="repeatPassphrase"
            id={`${id}-repeatPassphrase`}
            label="Repeat backup passphrase"
            type="password"
            autoComplete="off"
            minLength={8}
            maxLength={1024}
            required
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

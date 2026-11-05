import { expect, test } from 'bun:test';
import { backupFileFamily } from './backup-file-family';

test('routes archive signatures by bytes, not the filename', async () => {
  const tar = new Uint8Array(1024);
  tar.set(new TextEncoder().encode('ustar\0'), 257);
  expect(await backupFileFamily(new File([tar], 'wrong.orbis'))).toBe('settings');
  expect(await backupFileFamily(new File([`ORBISBK1${'x'.repeat(44)}`], 'wrong.orbis-settings'))).toBe('full');
  await expect(backupFileFamily(new File(['ORBISBK1'], 'short.orbis'))).rejects.toThrow('incomplete');
  await expect(backupFileFamily(new File(['not an archive'], 'backup.orbis-settings'))).rejects.toThrow('not a supported');
});

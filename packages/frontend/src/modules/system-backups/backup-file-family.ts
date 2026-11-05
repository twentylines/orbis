export async function backupFileFamily(file: Blob): Promise<'settings' | 'full'> {
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const text = (start: number, length: number) => String.fromCharCode(...header.slice(start, start + length));
  if (header.length >= 8 && text(0, 8) === 'ORBISBK1') {
    if (file.size < 52) throw new Error('This full backup is incomplete. Choose the complete file.');
    return 'full';
  }
  if (header.length >= 263 && text(257, 5) === 'ustar') {
    if (file.size < 1024 || file.size % 512 !== 0) throw new Error('This settings backup is incomplete. Choose the complete file.');
    return 'settings';
  }
  throw new Error('This file is not a supported Orbis backup, or it is incomplete.');
}

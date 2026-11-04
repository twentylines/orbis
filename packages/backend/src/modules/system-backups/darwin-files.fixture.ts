import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function stabilizeDarwinFixtureCreation(root: () => string | readonly string[]) {
  if (process.platform !== 'darwin') return () => undefined;
  const original = fs.open;
  const open = original.bind(fs);
  const wrapped: typeof fs.open = async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    try {
      const name = String(file);
      const scope = root();
      const roots = typeof scope === 'string' ? [scope] : scope;
      const exclusive =
        typeof flags === 'number' ? (flags & constants.O_CREAT) !== 0 && (flags & constants.O_EXCL) !== 0 : flags === 'wx' || flags === 'wx+';
      // Initialize native tracking flags before seals; first reads can otherwise change ctime.
      if (
        exclusive &&
        roots.some((value) => name.startsWith(`${value}${path.sep}`)) &&
        (await fs.realpath(path.dirname(name))) === path.dirname(name)
      ) {
        const details = await handle.stat();
        if (details.isFile() && details.nlink === 1 && details.uid === process.getuid?.())
          execFileSync(
            '/usr/bin/python3',
            [
              '-c',
              'import ctypes,os\nc=ctypes.CDLL(None,use_errno=True)\nc.fchflags.argtypes=[ctypes.c_int,ctypes.c_uint]\nif c.fchflags(3,os.fstat(3).st_flags|0x40|0x8000): raise OSError(ctypes.get_errno(),"fixture flags")',
            ],
            { stdio: ['ignore', 'pipe', 'pipe', handle.fd] },
          );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  fs.open = wrapped;
  return () => {
    if (fs.open === wrapped) fs.open = original;
  };
}

export function stabilizeExistingDarwinFixtures(root: string) {
  if (process.platform !== 'darwin') return;
  execFileSync('/usr/bin/python3', [
    '-c',
    'import os,stat,sys\ndef mark(p):\n s=os.lstat(p)\n if stat.S_ISREG(s.st_mode): os.chflags(p,s.st_flags|0x40|0x8000,follow_symlinks=False)\np=sys.argv[1]\nif stat.S_ISREG(os.lstat(p).st_mode): mark(p)\nelse:\n for root,_,files in os.walk(p,followlinks=False):\n  for name in files: mark(os.path.join(root,name))',
    root,
  ]);
}

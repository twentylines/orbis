import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { spawnAsync } from '../exec-helpers';
import { ArchiveService } from '@/core/archive/archive.service';
import type { LoggerService } from '@/core/logger/logger.service';

let directory: string;
const owned = new Set<number>();
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spawn-'));
});
afterEach(async () => {
  for (const pid of owned) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  owned.clear();
  await fs.rm(directory, { recursive: true, force: true });
});

it('does not start a command when cancellation was already requested', async () => {
  const controller = new AbortController();
  controller.abort();
  const marker = path.join(directory, 'unexpected');
  const result = await spawnAsync(process.execPath, ['-e', "require('node:fs').writeFileSync(process.argv[1],'started')", marker], {
    signal: controller.signal,
  });
  expect(result.stderr).toContain('cancelled');
  await expect(fs.stat(marker)).rejects.toThrow();
});

it('preserves the result contract for successful output, exit failure and spawn failure', async () => {
  expect(await spawnAsync(process.execPath, ['-e', "process.stdout.write('ok')"])).toEqual({ stdout: 'ok', stderr: '' });
  expect((await spawnAsync(process.execPath, ['-e', 'process.exit(7)'])).stderr).toContain('7');
  expect((await spawnAsync(path.join(directory, 'absent'), [])).stderr).not.toBe('');
});

it('round-trips real gzip archives with private file modes and portable links', async () => {
  const source = path.join(directory, 'source');
  const restored = path.join(directory, 'restored');
  await fs.mkdir(source);
  await fs.mkdir(restored);
  const body = 'A complete application snapshot.\n'.repeat(8192);
  await fs.writeFile(path.join(source, 'retained'), body, { mode: 0o600 });
  await fs.symlink('retained', path.join(source, 'portable-link'));
  const archive = new ArchiveService({ debug: () => undefined } as unknown as LoggerService);
  const target = path.join(directory, 'snapshot.tar.gz');
  expect((await archive.createTarGz(source, target)).stderr).toBe('');
  expect((await archive.listTarGz(target)).length).toBeGreaterThan(1);
  expect((await archive.extractTarGz(target, restored)).stderr).toBe('');
  expect(await fs.readFile(path.join(restored, 'retained'), 'utf8')).toBe(body);
  expect((await fs.stat(path.join(restored, 'retained'))).mode & 0o777).toBe(0o600);
  expect(await fs.readlink(path.join(restored, 'portable-link'))).toBe('retained');
});

it.skipIf(process.platform === 'win32')('reports signal termination even without command stderr', async () => {
  expect((await spawnAsync(process.execPath, ['-e', "process.kill(process.pid,'SIGTERM')"])).stderr).toContain('SIGTERM');
});

it.skipIf(process.platform === 'win32')(
  'cancels the entire command group before resolving, including a resistant descendant',
  async () => {
    const controller = new AbortController();
    const marker = path.join(directory, 'child.json');
    const parent = path.join(directory, 'parent.json');
    const source = [
      "process.on('SIGTERM',()=>{});",
      "require('node:fs').writeFileSync(process.argv[2],JSON.stringify({pid:process.pid}));",
      "const child=require('node:child_process').spawn(process.execPath,['-e',",
      JSON.stringify(
        "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],JSON.stringify({pid:process.pid}));setInterval(()=>{},10000)",
      ),
      ",process.argv[1]],{stdio:'inherit'});setInterval(()=>{},10000);",
    ].join('');
    const running = spawnAsync(process.execPath, ['-e', source, marker, parent], { signal: controller.signal });
    await vi.waitFor(async () => {
      for (const file of [marker, parent]) owned.add(JSON.parse(await fs.readFile(file, 'utf8')).pid);
      expect(owned.size).toBe(2);
    });
    controller.abort();
    expect((await running).stderr).not.toBe('');
    await vi.waitFor(() => {
      for (const pid of owned) expect(() => process.kill(pid, 0)).toThrow();
    });
    owned.clear();
  },
  10_000,
);

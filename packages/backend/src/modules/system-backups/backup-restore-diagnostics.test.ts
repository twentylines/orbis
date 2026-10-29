import { PassThrough } from 'node:stream';
import type Dockerode from 'dockerode';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, expect, it, vi } from 'vitest';
import { RestoreRolledBackError } from './backup-restore-coordinator';
import {
  attachVerifierDiagnostics,
  reportVerifierStartupFailure,
  restoreFailureProgress,
  VerifierDiagnosticParser,
  VerifierStartupDiagnostics,
  VerifierStartupFailure,
  verifierDiagnosticCheck,
  verifierMarkerPrefix,
  verifierStartupMarker,
} from './backup-restore-diagnostics';

afterEach(() => vi.useRealTimers());
function frame(text: string, channel = 2) {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
const marker = (stage = 'env', failure = 'readonly') => `${verifierMarkerPrefix}${JSON.stringify({ stage, failure })}\n`;
it('captures only one fixed stderr marker across fragmented Docker frames and ignores raw stdout/stderr', () => {
  const parser = new VerifierDiagnosticParser();
  const data = Buffer.concat([frame('arbitrary sensitive startup error\n'), frame(marker('app', 'permission'), 1), frame(marker())]);
  for (let offset = 0; offset < data.length; offset += 3) parser.push(data.subarray(offset, offset + 3));
  expect(parser.result()).toEqual({ stage: 'env', failure: 'readonly' });
  expect(JSON.stringify(parser.result())).not.toContain('sensitive');
  expect(verifierDiagnosticCheck(parser.result() as { stage: 'env'; failure: 'readonly' })).toBe('verifier-env-readonly');
});
it('rejects unknown fields/enums, duplicate markers, malformed/truncated/oversized frames and unbounded lines', () => {
  for (const text of [
    marker('private-path', 'readonly'),
    marker('env', 'private-error'),
    `${verifierMarkerPrefix}{"stage":"env","stage":"app","failure":"readonly"}\n`,
    marker().replace('"stage"', '"st\rage"'),
    `${verifierMarkerPrefix}{"stage":"env","failure":"readonly","message":"private"}\n`,
    marker() + marker(),
    'arbitrary\n',
    `${verifierMarkerPrefix}${'a'.repeat(600)}\n`,
  ]) {
    const parser = new VerifierDiagnosticParser();
    parser.push(frame(text));
    expect(parser.result()).toBeUndefined();
  }
  const malformed = new VerifierDiagnosticParser();
  const bad = frame(marker());
  bad[1] = 1;
  malformed.push(bad);
  expect(malformed.result()).toBeUndefined();
  const truncated = new VerifierDiagnosticParser();
  truncated.push(frame(marker()).subarray(0, 10));
  expect(truncated.result()).toBeUndefined();
  const excessive = new VerifierDiagnosticParser();
  excessive.push(frame(marker()));
  excessive.push(Buffer.alloc(65537));
  expect(excessive.result()).toBeUndefined();
  expect(excessive.unusable).toBe(true);
  const incomplete = new VerifierDiagnosticParser();
  incomplete.push(frame(marker().trimEnd()));
  expect(incomplete.result()).toBeUndefined();
});
it('classifies only exact Node/PG error codes and discards arbitrary message/stack/cause/code values', async () => {
  const diagnostics = new VerifierStartupDiagnostics();
  diagnostics.enable();
  for (const [code, expected] of [
    ['EROFS', 'readonly'],
    ['EACCES', 'permission'],
    ['ENOENT', 'missing'],
    ['28P01', 'db-auth'],
    ['not-a-code', 'startup-failed'],
    ['toString', 'startup-failed'],
  ]) {
    try {
      await diagnostics.run('database', async () => {
        throw Object.assign(new Error('private value'), { code, cause: { secret: 'private' } });
      });
      throw Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifierStartupFailure);
      const output = verifierStartupMarker(error as VerifierStartupFailure);
      expect(output).toBe(marker('database', expected));
      expect(output).not.toContain('private');
      expect(JSON.stringify(error)).not.toContain('private');
    }
  }
});
it('provider failure emits a safe marker, exits the simulated startup with1 and cannot reach listen/health', async () => {
  const diagnostics = new VerifierStartupDiagnostics();
  diagnostics.enable();
  @Module({
    providers: [
      {
        provide: 'broken-provider',
        useFactory: () => {
          throw Object.assign(new Error('private provider detail'), { code: 'EACCES' });
        },
      },
    ],
  })
  class FailingModule {}
  const emitted: string[] = [];
  const listen = vi.fn();
  const exit = await (async () => {
    try {
      const app = await diagnostics.run('app', () => NestFactory.create(FailingModule, { abortOnError: !diagnostics.active, logger: false }));
      await listen();
      await app.close();
      return 0;
    } catch (error) {
      if (error instanceof VerifierStartupFailure) emitted.push(verifierStartupMarker(error));
      return 1;
    }
  })();
  expect(exit).toBe(1);
  expect(listen).not.toHaveBeenCalled();
  expect(emitted).toEqual([marker('app', 'permission')]);
});
it('ordinary startup retains its original error behavior and nested verifier stages retain the first failure stage', async () => {
  const diagnostics = new VerifierStartupDiagnostics();
  const error = new Error('ordinary failure');
  expect(diagnostics.active).toBe(false);
  await expect(
    diagnostics.run('app', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  diagnostics.enable();
  await expect(
    diagnostics.run('database', () =>
      diagnostics.run('recovery', async () => {
        throw error;
      }),
    ),
  ).rejects.toMatchObject({ diagnostic: { stage: 'recovery', failure: 'startup-failed' } });
});
it('preserves only allowlisted failure checks across rollback causes and never surfaces arbitrary values', () => {
  const cause = Object.assign(new Error('private details'), { runtimeCheck: 'verifier-env-readonly' });
  expect(restoreFailureProgress(new RestoreRolledBackError(false, cause), 'restoring')).toEqual({
    stage: 'restoring',
    check: 'verifier-env-readonly',
  });
  expect(restoreFailureProgress(Object.assign(new Error('private'), { runtimeCheck: 'private-value' }), 'restoring')).toEqual({
    stage: 'restoring',
    check: undefined,
  });
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  expect(restoreFailureProgress(cyclic, 'restoring').check).toBeUndefined();
});
it('attaches stderr before startup, finishes without waiting indefinitely and closes on cancellation', async () => {
  const stream = new PassThrough();
  const attach = vi.fn().mockResolvedValue(stream);
  const abort = new AbortController();
  const capture = await attachVerifierDiagnostics({ attach } as unknown as Dockerode.Container, abort.signal);
  expect(attach).toHaveBeenCalledWith(
    expect.objectContaining({ stream: true, stdout: false, stderr: true, stdin: false, logs: false, hijack: true }),
  );
  stream.end(frame(marker('listen', 'missing')));
  expect(await capture.finish()).toEqual({ stage: 'listen', failure: 'missing' });
  capture.close();
  expect(stream.destroyed).toBe(true);
  const active = new PassThrough();
  const second = await attachVerifierDiagnostics({ attach: async () => active } as unknown as Dockerode.Container, abort.signal);
  abort.abort();
  expect(active.destroyed).toBe(true);
  second.close();
});
it('bounds the connection deadline and closes excess input without retaining its contents', async () => {
  vi.useFakeTimers();
  const attach = vi.fn(
    (options: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) =>
        options.abortSignal.addEventListener('abort', () => reject(new Error('connection timed out')), { once: true }),
      ),
  );
  const pending = attachVerifierDiagnostics({ attach } as unknown as Dockerode.Container, new AbortController().signal);
  const failure = expect(pending).rejects.toThrow('connection timed out');
  await vi.advanceTimersByTimeAsync(2000);
  await failure;
  const stream = new PassThrough();
  const capture = await attachVerifierDiagnostics({ attach: async () => stream } as unknown as Dockerode.Container, new AbortController().signal);
  stream.write(Buffer.alloc(65537));
  expect(stream.destroyed).toBe(true);
  expect(await capture.finish()).toBeUndefined();
  capture.close();
});

it('flushes the fixed marker before exit and bounds a stalled write to250ms without duplicate exit', async () => {
  vi.useFakeTimers();
  const exit = vi.fn();
  const output: string[] = [];
  let finished: (() => void) | undefined;
  const error = new VerifierStartupFailure('env', Object.assign(new Error('private input'), { code: 'EROFS' }));
  reportVerifierStartupFailure(
    error,
    (value, done) => {
      output.push(value);
      finished = done;
    },
    exit,
  );
  expect(exit).not.toHaveBeenCalled();
  expect(output).toEqual([marker()]);
  finished?.();
  expect(exit).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(250);
  expect(exit).toHaveBeenCalledTimes(1);
  const timeoutExit = vi.fn();
  reportVerifierStartupFailure(error, () => undefined, timeoutExit);
  await vi.advanceTimersByTimeAsync(249);
  expect(timeoutExit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(timeoutExit).toHaveBeenCalledTimes(1);
});

it('reads bounded explicit cause codes without evaluating getters and keeps unclassified failures generic', () => {
  const nested = new VerifierStartupFailure('database', { cause: { code: '28P01', message: 'private query' } });
  expect(nested.diagnostic).toEqual({ stage: 'database', failure: 'db-auth' });
  expect(verifierStartupMarker(nested)).not.toContain('private query');
  const getter = Object.defineProperty({}, 'code', {
    get: () => {
      throw new Error('must not evaluate');
    },
  });
  expect(new VerifierStartupFailure('startup', getter).diagnostic).toEqual({ stage: 'startup', failure: 'startup-failed' });
  expect(
    restoreFailureProgress(
      Object.defineProperty({}, 'runtimeCheck', {
        get: () => {
          throw Error('must not evaluate');
        },
      }),
      'restoring',
    ),
  ).toEqual({ stage: 'restoring', check: undefined });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backupMaintenanceActive, coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { CoreCaptureStartup } from './time-machine-core-startup';

vi.mock('@/common/backup-maintenance', () => ({ backupMaintenanceActive: vi.fn(), coreCaptureRecoveryRequired: vi.fn() }));
vi.mock('@/common/installation-mode', () => ({ installationMode: vi.fn() }));

const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
function fixture() {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const proof = {
    queueGeneration: 1,
    queues: names.map((name) => ({ name, messages: 0 as const, consumers: 1 as const })),
    recheck: step('recheck'),
  };
  const options = {
    initializeRecovery: step('recovery'),
    initializeServices: step('services'),
    preparePresentation: step('presentation'),
    startConsumers: step('consumers'),
    verifyConsumers: vi.fn(async () => {
      calls.push('verify');
      return proof;
    }),
    activateTimers: step('timers'),
  };
  return { calls, proof, options, startup: new CoreCaptureStartup(options) };
}

beforeEach(() => {
  vi.mocked(installationMode).mockReturnValue({ phase: 'normal' } as ReturnType<typeof installationMode>);
  vi.mocked(backupMaintenanceActive).mockReturnValue(true);
  vi.mocked(coreCaptureRecoveryRequired).mockReturnValue(false);
});

describe('CoreCaptureStartup', () => {
  it('orders preparation and shares each operation across concurrent calls', async () => {
    const f = fixture();
    const first = f.startup.prepare();
    expect(f.startup.prepare()).toBe(first);
    await first;
    expect(f.calls).toEqual(['recovery', 'services', 'presentation', 'consumers', 'verify', 'recheck', 'recheck']);
    const activation = f.startup.activate();
    expect(f.startup.activate()).toBe(activation);
    await activation;
    await f.startup.activate();
    expect(f.calls.slice(7)).toEqual(['recheck', 'timers', 'recheck']);
    expect(f.options.activateTimers).toHaveBeenCalledOnce();
  });

  it.each(['initializeRecovery', 'initializeServices', 'preparePresentation', 'startConsumers', 'verifyConsumers'] as const)(
    'retains failure in %s without starting subsequent phases',
    async (phase) => {
      const f = fixture();
      f.options[phase].mockRejectedValueOnce(new Error('failed'));
      const phases = ['initializeRecovery', 'initializeServices', 'preparePresentation', 'startConsumers', 'verifyConsumers'] as const;
      await expect(f.startup.prepare()).rejects.toThrow('failed');
      await expect(f.startup.prepare()).rejects.toThrow('failed');
      for (const later of phases.slice(phases.indexOf(phase) + 1)) expect(f.options[later]).not.toHaveBeenCalled();
      await expect(f.startup.activate()).rejects.toThrow();
      expect(f.options.activateTimers).not.toHaveBeenCalled();
    },
  );

  it.each(['mode', 'hold', 'capture'] as const)('rejects invalid %s before starting', async (condition) => {
    if (condition === 'mode') vi.mocked(installationMode).mockReturnValue({ phase: 'resume' } as ReturnType<typeof installationMode>);
    if (condition === 'hold') vi.mocked(backupMaintenanceActive).mockReturnValue(false);
    if (condition === 'capture') vi.mocked(coreCaptureRecoveryRequired).mockReturnValue(true);
    const f = fixture();
    await expect(f.startup.prepare()).rejects.toThrow();
    expect(f.options.initializeRecovery).not.toHaveBeenCalled();
  });

  it('detects hold changes after a phase and stops', async () => {
    const f = fixture();
    f.options.initializeServices.mockImplementationOnce(async () => {
      vi.mocked(backupMaintenanceActive).mockReturnValue(false);
    });
    await expect(f.startup.prepare()).rejects.toThrow();
    expect(f.options.preparePresentation).not.toHaveBeenCalled();
  });

  it.each(['generation', 'missing', 'duplicate', 'messages', 'consumers', 'extra'] as const)('rejects malformed proof: %s', async (fault) => {
    const f = fixture();
    const [first, second] = f.proof.queues;
    if (!first || !second) throw new Error('consumer fixture needs two queues');
    if (fault === 'generation') f.proof.queueGeneration = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'missing') f.proof.queues.pop();
    if (fault === 'duplicate') first.name = second.name;
    if (fault === 'messages') Object.assign(first, { messages: 1 });
    if (fault === 'consumers') Object.assign(first, { consumers: 0 });
    if (fault === 'extra') Object.assign(f.proof, { extra: true });
    await expect(f.startup.prepare()).rejects.toThrow('consumer proof');
    expect(f.options.activateTimers).not.toHaveBeenCalled();
  });

  it('prevents timers when readiness changes or recheck fails', async () => {
    const f = fixture();
    await f.startup.prepare();
    f.proof.recheck.mockRejectedValueOnce(new Error('queue changed'));
    await expect(f.startup.activate()).rejects.toThrow('queue changed');
    await expect(f.startup.activate()).rejects.toThrow('queue changed');
    expect(f.options.activateTimers).not.toHaveBeenCalled();
  });

  it('rejects activation after the hold changes', async () => {
    const f = fixture();
    await f.startup.prepare();
    vi.mocked(backupMaintenanceActive).mockReturnValue(false);
    await expect(f.startup.activate()).rejects.toThrow();
    expect(f.options.activateTimers).not.toHaveBeenCalled();
  });
});

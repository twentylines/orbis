import { afterEach, describe, expect, it, vi } from 'vitest';
import { installationHeld, installationMode } from './installation-mode';

const transaction = 'f92e8862-38b5-4e81-bc84-f9131944872d';

afterEach(() => vi.unstubAllEnvs());

describe('installer process mode', () => {
  it('keeps an ordinary controller unchanged when no installer mode is set', () => {
    expect(installationMode({})).toEqual({ phase: 'normal', transactionId: null });
  });

  it.each(['hold', 'resume'])('accepts a complete %s transaction', (phase) => {
    expect(installationMode({ ORBIS_INSTALLER_TRANSACTION: transaction, ORBIS_INSTALLER_PHASE: phase })).toEqual({
      phase,
      transactionId: transaction,
    });
  });

  it.each([
    { ORBIS_INSTALLER_TRANSACTION: transaction },
    { ORBIS_INSTALLER_PHASE: 'hold' },
    { ORBIS_INSTALLER_TRANSACTION: '', ORBIS_INSTALLER_PHASE: 'hold' },
    { ORBIS_INSTALLER_TRANSACTION: transaction, ORBIS_INSTALLER_PHASE: 'normal' },
    { ORBIS_INSTALLER_TRANSACTION: 'private-invalid-value', ORBIS_INSTALLER_PHASE: 'hold' },
  ])('fails closed for incomplete or invalid installer input', (environment) => {
    expect(() => installationMode(environment)).toThrow('Installer mode needs a valid transaction ID');
    try {
      installationMode(environment);
    } catch (error) {
      expect(String(error)).not.toContain('private-invalid-value');
    }
  });

  it('reads the container environment without providing an HTTP release operation', () => {
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', transaction);
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    expect(installationHeld()).toBe(true);
  });

  it('keeps the startup hold even if a saved environment file contains another installer phase', async () => {
    vi.resetModules();
    const fresh = await import('./installation-mode');
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', transaction);
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'hold');
    fresh.captureInstallationMode();
    vi.stubEnv('ORBIS_INSTALLER_TRANSACTION', 'different-saved-value');
    vi.stubEnv('ORBIS_INSTALLER_PHASE', 'resume');
    expect(fresh.installationMode()).toEqual({ phase: 'hold', transactionId: transaction });
    expect(fresh.installationHeld()).toBe(true);
  });

  it.each([
    ['different transaction', { ORBIS_INSTALLER_TRANSACTION: transaction, ORBIS_INSTALLER_PHASE: 'resume' }, 'f92e8862-38b5-4e81-bc84-f9131944872e'],
    ['hold mode', { ORBIS_INSTALLER_TRANSACTION: transaction, ORBIS_INSTALLER_PHASE: 'hold' }, transaction],
    ['normal mode', {}, transaction],
  ] as const)('cannot release restore startup for %s', async (_name, environment, releaseId) => {
    vi.resetModules();
    const fresh = await import('./installation-mode');
    fresh.captureInstallationMode(environment);

    expect(fresh.releaseRestoreInstallationMode(releaseId)).toBe(false);
    const phase = (environment as { ORBIS_INSTALLER_PHASE?: string }).ORBIS_INSTALLER_PHASE;
    expect(fresh.installationMode()).toEqual(
      phase === 'resume'
        ? { phase: 'resume', transactionId: transaction }
        : phase === 'hold'
          ? { phase: 'hold', transactionId: transaction }
          : { phase: 'normal', transactionId: null },
    );
  });

  it('releases only the matching captured resume transaction and only once', async () => {
    vi.resetModules();
    const fresh = await import('./installation-mode');
    fresh.captureInstallationMode({ ORBIS_INSTALLER_TRANSACTION: transaction, ORBIS_INSTALLER_PHASE: 'resume' });

    expect(fresh.releaseRestoreInstallationMode(transaction)).toBe(true);
    expect(fresh.installationMode()).toEqual({ phase: 'normal', transactionId: null });
    expect(fresh.releaseRestoreInstallationMode(transaction)).toBe(false);
  });
});

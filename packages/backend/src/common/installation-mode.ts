type InstallerEnvironment = Partial<Pick<NodeJS.ProcessEnv, 'ORBIS_INSTALLER_TRANSACTION' | 'ORBIS_INSTALLER_PHASE'>>;

export type InstallationMode = { phase: 'normal'; transactionId: null } | { phase: 'hold' | 'resume'; transactionId: string };

let startupMode: InstallationMode | undefined;

export const installationMode = (environment?: InstallerEnvironment): InstallationMode => {
  if (environment === undefined && startupMode) return startupMode;
  const selected = environment ?? {
    ORBIS_INSTALLER_TRANSACTION: process.env.ORBIS_INSTALLER_TRANSACTION,
    ORBIS_INSTALLER_PHASE: process.env.ORBIS_INSTALLER_PHASE,
  };
  const transactionId = selected.ORBIS_INSTALLER_TRANSACTION;
  const phase = selected.ORBIS_INSTALLER_PHASE;
  if (transactionId === undefined && phase === undefined) return { phase: 'normal', transactionId: null };
  if (
    typeof transactionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId) ||
    (phase !== 'hold' && phase !== 'resume')
  ) {
    throw new Error('Installer mode needs a valid transaction ID and a hold or resume phase.');
  }
  return { phase, transactionId };
};

export const captureInstallationMode = (environment?: InstallerEnvironment) => {
  startupMode ??= Object.freeze(installationMode(environment));
  return startupMode;
};

export const releaseRestoreInstallationMode = (transactionId: string) => {
  if (startupMode?.phase !== 'resume' || startupMode.transactionId !== transactionId) return false;
  startupMode = Object.freeze({ phase: 'normal', transactionId: null });
  return true;
};

export const installationHeld = () => installationMode().phase === 'hold';
export const INSTALLATION_MESSAGE = 'Installation is in progress. Wait for the installer to finish.';

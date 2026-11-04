// Read the runtime instruction before persisted settings can overwrite process.env.
const preserveNetworkAccess = process.env.ORBIS_CONTROLLER_PRESERVE_NETWORK_ACCESS === '1';

export const controllerOverlayStartup = () => preserveNetworkAccess;

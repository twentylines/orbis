export const nearbyUnavailableCodes = ['host-unavailable', 'unsupported', 'https-required', 'interface-unavailable'] as const;
export type NearbyUnavailableCode = (typeof nearbyUnavailableCodes)[number];
export function nearbyUnavailableCode(value: unknown): NearbyUnavailableCode | undefined {
  return nearbyUnavailableCodes.find((code) => code === value);
}
export function nearbyUnavailableMessage(code?: NearbyUnavailableCode) {
  if (code === 'unsupported')
    return 'This installation does not support nearby discovery. Update the Orbis host service, or enter a server address manually.';
  if (code === 'https-required') return 'This host service needs a private HTTPS hostname before it can advertise. Set up HTTPS, then refresh.';
  if (code === 'interface-unavailable')
    return 'No eligible private LAN interface is ready. Check the server’s LAN connection, or enter a server address manually.';
  return 'The host discovery service is unavailable. Check its installation and connection, or enter a server address manually.';
}
export function nearbyAdvertisingMessage(state: { enabled: boolean; hintVersion?: 2; sharing: object | null }) {
  if (!state.enabled) return 'Nearby discovery is off.';
  if (state.sharing)
    return 'kind' in state.sharing && state.sharing.kind === 'address'
      ? 'Advertising an unverified private address. HTTPS is required before pairing or transfer.'
      : 'Advertising this server’s private HTTPS address. Pairing and transfers still require approval.';
  return state.hintVersion === 2
    ? 'Discovery is allowed but not advertising. Check the host service and private LAN connection.'
    : 'This older host service requires a private HTTPS hostname and a matching LAN interface. Set up HTTPS if needed, then refresh.';
}

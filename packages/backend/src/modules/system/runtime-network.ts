export type RuntimeNetworkCounter = { iface: string; rx_bytes: number; tx_bytes: number };
export type RuntimeNetworkSnapshot = RuntimeNetworkCounter & { at: number };

export function parseRuntimeNetwork(input: string): Map<string, RuntimeNetworkCounter> {
  const counters = new Map<string, RuntimeNetworkCounter>();
  if (input.length > 1024 * 1024) return counters;
  for (const line of input.split('\n')) {
    const fields = line.match(/^\s*([^:\s]{1,128}):\s*(.*?)\s*$/);
    if (!fields?.[1] || !fields[2] || Array.from(fields[1]).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
      continue;
    const columns = fields[2].split(/\s+/);
    if (columns.length !== 16 || !columns.every((value) => /^\d+$/.test(value))) continue;
    const received = Number(columns[0]);
    const transmitted = Number(columns[8]);
    if (!Number.isSafeInteger(received) || !Number.isSafeInteger(transmitted)) continue;
    counters.set(fields[1], { iface: fields[1], rx_bytes: received, tx_bytes: transmitted });
  }
  return counters;
}

export function runtimeNetworkRates(previous: RuntimeNetworkSnapshot | null, current: RuntimeNetworkSnapshot) {
  const elapsed = previous ? current.at - previous.at : 0;
  const rate = (field: 'rx_bytes' | 'tx_bytes') => {
    if (!previous || previous.iface !== current.iface || elapsed <= 0 || elapsed > 30_000 || current[field] < previous[field]) return null;
    return ((current[field] - previous[field]) * 1000) / elapsed;
  };
  return { iface: current.iface, rx_bytes: current.rx_bytes, tx_bytes: current.tx_bytes, rx_sec: rate('rx_bytes'), tx_sec: rate('tx_bytes') };
}

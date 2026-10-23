export const maximumHomePins = 512;

export function validHomePins(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximumHomePins &&
    new Set(value).size === value.length &&
    value.every((urn) => typeof urn === 'string' && urn.length > 2 && urn.length <= 180 && /^[^:]+:[^:]+$/.test(urn))
  );
}

export function moveHomePin<T extends string>(pins: T[], urn: T, offset: -1 | 1): T[] {
  const index = pins.indexOf(urn);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= pins.length) return pins;
  const next = [...pins];
  next.splice(index, 1);
  next.splice(target, 0, urn);
  return next;
}

export function placeHomePin<T extends string>(pins: T[], urn: T, before: T | null): T[] {
  if (urn === before || !pins.includes(urn) || (before !== null && !pins.includes(before))) return pins;
  if (before === null && pins.at(-1) === urn) return pins;
  const next = pins.filter((pin) => pin !== urn);
  next.splice(before === null ? next.length : next.indexOf(before), 0, urn);
  return next;
}

export function homeApps<T extends { info: { urn: string } }>(installed: T[], pins: string[], showAll: boolean): T[] {
  const positions = new Map(pins.map((urn, index) => [urn, index]));
  const ordered = [...installed].sort(
    (left, right) => (positions.get(left.info.urn) ?? Number.POSITIVE_INFINITY) - (positions.get(right.info.urn) ?? Number.POSITIVE_INFINITY),
  );
  if (showAll) return ordered;
  const presentPins = installed.filter(({ info }) => positions.has(info.urn)).length;
  return ordered.slice(0, Math.max(3, presentPins));
}

export function workspaceRows<T extends string>(order: T[], wide: T[]): T[][] {
  const rows: T[][] = [];
  for (const id of order) {
    const last = rows.at(-1);
    const previous = last?.[0];
    if (!wide.includes(id) && last?.length === 1 && previous !== undefined && !wide.includes(previous)) last.push(id);
    else rows.push([id]);
  }
  return rows;
}

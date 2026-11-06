import { encodeAppVolumePins, type AppVolumePins } from './app-volume-pins';

const fail = () => new Error('The effective app configuration does not match its restored volume bindings.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const reserved = 'orbis_retained_';
const maximum = 16 * 1024 * 1024;

// Project one exported Compose document, rather than merge mount objects from
// several files. Old bind, tmpfs and volume-subpath options cannot survive it.
export function projectAppVolumePins(effective: unknown, pins: AppVolumePins): Record<string, unknown> {
  const overlay: unknown = JSON.parse(encodeAppVolumePins(pins).toString('utf8'));
  if (!record(overlay) || !record(overlay.volumes) || !record(overlay.services)) throw fail();
  if (!record(effective) || effective.name !== pins.project || !record(effective.services) || effective.include !== undefined) throw fail();
  const size = Buffer.byteLength(JSON.stringify(effective));
  if (size > maximum || Object.keys(effective.services).length > 256) throw fail();
  const result: Record<string, unknown> = structuredClone(effective);
  const volumes = effective.volumes ?? {};
  if (!record(volumes)) throw fail();
  const names = new Set(pins.services.flatMap((service) => service.mounts.map((mount) => mount.volume)));
  for (const [key, definition] of Object.entries(volumes))
    if (key.startsWith(reserved) || !record(definition) || names.has(String(definition.name ?? ''))) throw fail();
  const services = result.services as Record<string, unknown>;
  for (const service of Object.values(services)) {
    if (!record(service) || service.extends !== undefined || service.env_file !== undefined || service.label_file !== undefined) throw fail();
    if (service.volumes !== undefined && !Array.isArray(service.volumes)) throw fail();
    const targets = new Set<string>();
    for (const mount of (service.volumes as unknown[] | undefined) ?? []) {
      if (
        !record(mount) ||
        typeof mount.target !== 'string' ||
        targets.has(mount.target) ||
        (typeof mount.source === 'string' && mount.source.startsWith(reserved))
      )
        throw fail();
      targets.add(mount.target);
    }
  }
  for (const pin of pins.services) {
    const service = services[pin.name];
    const replacement = overlay.services[pin.name];
    if (!record(service) || !record(replacement) || !Array.isArray(replacement.volumes)) throw fail();
    const targets = new Set(pin.mounts.map((mount) => mount.target));
    service.volumes = [
      ...((service.volumes as Record<string, unknown>[] | undefined) ?? []).filter((mount) => !targets.has(mount.target as string)),
      ...replacement.volumes,
    ];
  }
  result.volumes = { ...structuredClone(volumes), ...overlay.volumes };
  if (Buffer.byteLength(JSON.stringify(result)) > maximum) throw fail();
  return result;
}

export function encodePinnedCompose(effective: unknown, pins: AppVolumePins) {
  // `compose config` already escapes literal dollars for round-tripping. A
  // second escape pass changes passwords and command arguments at execution.
  return Buffer.from(JSON.stringify(projectAppVolumePins(effective, pins)));
}

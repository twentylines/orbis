import { migrationRecord as record } from './app-migration-engine';

/** Explicit app/user profiles plus required dependency closure; no inherited Core profile settings. */
export function activeAppServices(effective: unknown, profiles: readonly string[]) {
  if (!record(effective) || !record(effective.services)) throw new Error('App service profiles could not be verified.');
  const services = effective.services;
  const active = new Set<string>();
  for (const [name, service] of Object.entries(services)) {
    if (
      !record(service) ||
      (service.profiles !== undefined && (!Array.isArray(service.profiles) || service.profiles.some((value) => typeof value !== 'string')))
    )
      throw new Error('App service profiles could not be verified.');
    if (
      !Array.isArray(service.profiles) ||
      !service.profiles.length ||
      profiles.includes('*') ||
      service.profiles.some((value) => profiles.includes(String(value)))
    )
      active.add(name);
  }
  const visit = (name: string, trail = new Set<string>()) => {
    if (trail.has(name)) throw new Error('App service dependencies could not be verified.');
    const service = services[name];
    if (!record(service)) throw new Error('App service dependencies could not be verified.');
    if (service.depends_on === undefined) return;
    if (!record(service.depends_on)) throw new Error('App service dependencies could not be verified.');
    for (const [dependency, settings] of Object.entries(service.depends_on)) {
      if (!record(settings)) throw new Error('App service dependencies could not be verified.');
      if (settings.required === false && !active.has(dependency)) continue;
      if (!active.has(dependency)) {
        active.add(dependency);
        visit(dependency, new Set([...trail, name]));
      }
    }
  };
  for (const name of [...active]) visit(name);
  return [...active].sort();
}

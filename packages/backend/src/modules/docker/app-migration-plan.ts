import { createHash } from 'node:crypto';
import path from 'node:path';
import { isScalar, parseDocument, visit } from 'yaml';
import { appMigrationFileLimit, appMigrationIdPattern, type AppMigrationSource } from '../apps/app-migrations';

const invalid = () => new Error('App migration requires a supported isolated service and app-data binds.');
const incomplete = () => new Error('App migration environment is incomplete.');
const variable = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const permitted = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown, maximum = 65536): value is string =>
  typeof value === 'string' && Buffer.byteLength(value) <= maximum && !value.includes('\0') && !/\p{Surrogate}/u.test(value);
const canonical = (value: unknown): value is string =>
  text(value, 4096) && value.startsWith('/') && value !== '/' && path.posix.normalize(value) === value && !/[\\\r\n]/.test(value);
const inside = (root: string, value: string) => value === root || value.startsWith(root + '/');
const overlap = (left: string, right: string) => inside(left, right) || inside(right, left);
const target = (value: unknown): value is string =>
  canonical(value) &&
  !['/proc', '/sys', '/dev'].some((root) => overlap(root, value)) &&
  !['/var/run/docker.sock', '/run/docker.sock', '/run/orbis', '/etc/traefik', '/shared'].some((root) => inside(root, value));

export type AppMigrationDefinition = Readonly<{
  id: string;
  sourceSha256: string;
  image: string;
  user?: string;
  entrypoint?: readonly string[];
  command?: readonly string[];
  workingDirectory?: string;
  platform?: string;
  environment: Readonly<Record<string, string>>;
  mounts: readonly Readonly<{ source: string; target: string; readOnly: boolean }>[];
  temporary: readonly Readonly<{ target: string; sizeBytes: number; mode: number; uid?: number; gid?: number }>[];
}>;

/** Compose substitution uses only the explicit app/user map, never process.env. */
export function interpolateAppMigration(input: string, environment: ReadonlyMap<string, string>, depth = 0): string {
  if (!text(input, appMigrationFileLimit) || depth > 16) throw invalid();
  const output: string[] = [];
  let bytes = 0;
  const append = (value: string) => {
    bytes += Buffer.byteLength(value);
    if (bytes > appMigrationFileLimit) throw invalid();
    output.push(value);
  };
  for (let offset = 0; offset < input.length; ) {
    if (input[offset] !== '$') {
      const found = input.indexOf('$', offset);
      const end = found < 0 ? input.length : found;
      append(input.slice(offset, end));
      offset = end;
      continue;
    }
    const next = input[offset + 1];
    if (next === '$') {
      append('$');
      offset += 2;
      continue;
    }
    if (next !== '{') {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(offset + 1))?.[0];
      if (!name) {
        append('$');
        offset++;
        continue;
      }
      append(environment.get(name) ?? '');
      offset += name.length + 1;
      continue;
    }
    let end = offset + 2;
    let braces = 1;
    for (; end < input.length; end++) {
      if (input[end] === '{') braces++;
      if (input[end] === '}' && --braces === 0) break;
    }
    if (braces !== 0) throw invalid();
    const expression = input.slice(offset + 2, end);
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])([\s\S]*))?$/.exec(expression);
    if (!match) throw invalid();
    const name = match[1] ?? '';
    const operator = match[2];
    const value = environment.get(name) ?? '';
    const present = environment.has(name);
    // Compose resolves nested operands before choosing the substitution branch.
    const operand = operator ? interpolateAppMigration(match[3] ?? '', environment, depth + 1) : '';
    const selected = present && (!operator?.startsWith(':') || value !== '');
    if (!operator) append(value);
    else if (operator.endsWith('-')) append(selected ? value : operand);
    else if (operator.endsWith('+')) append(selected ? operand : '');
    else {
      if (!selected) throw incomplete();
      append(value);
    }
    offset = end + 1;
  }
  return output.join('');
}

function bounded(value: unknown, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 16384 || depth > 16) throw invalid();
  if (typeof value === 'string') {
    if (!text(value, appMigrationFileLimit)) throw invalid();
    return;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
  )
    return;
  if (Array.isArray(value)) {
    for (const child of value) bounded(child, depth + 1, budget);
    return;
  }
  if (!plain(value)) throw invalid();
  for (const [key, child] of Object.entries(value)) {
    if (!text(key, 256)) throw invalid();
    bounded(child, depth + 1, budget);
  }
}

/** A definition is validated input, not permission to create a writable runner. */
export function parseAppMigration(
  source: AppMigrationSource,
  context: { appDataHostPath: string; environment: Readonly<Record<string, string>> },
): AppMigrationDefinition {
  try {
    if (
      typeof source.id !== 'string' ||
      !appMigrationIdPattern.test(source.id) ||
      !Buffer.isBuffer(source.bytes) ||
      !source.bytes.length ||
      source.bytes.length > appMigrationFileLimit ||
      createHash('sha256').update(source.bytes).digest('hex') !== source.sha256 ||
      !canonical(context.appDataHostPath)
    )
      throw invalid();
    if (!plain(context.environment) || Object.keys(context.environment).length > 2048) throw invalid();
    const environment = new Map<string, string>();
    let environmentBytes = 0;
    for (const [key, value] of Object.entries(context.environment)) {
      if (!variable.test(key) || !text(value)) throw invalid();
      environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value);
      if (environmentBytes > 1024 * 1024) throw invalid();
      environment.set(key, value);
    }
    const document = parseDocument(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes), {
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
      logLevel: 'silent',
    });
    if (document.errors.length || document.warnings.length) throw invalid();
    visit(document, {
      Alias() {
        throw invalid();
      },
      Pair(_key, pair) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw invalid();
      },
    });
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    bounded(value);
    if (
      !plain(value) ||
      !permitted(value, ['services', 'version']) ||
      !plain(value.services) ||
      Object.keys(value.services).join(',') !== 'migration'
    )
      throw invalid();
    if (value.version !== undefined && (typeof value.version !== 'string' || !/^3(?:\.[0-9]+)?$/.test(value.version))) throw invalid();
    const service = value.services.migration;
    if (
      !plain(service) ||
      !permitted(service, [
        'image',
        'user',
        'entrypoint',
        'command',
        'working_dir',
        'environment',
        'volumes',
        'tmpfs',
        'network_mode',
        'read_only',
        'restart',
        'cap_drop',
        'stdin_open',
        'tty',
        'platform',
        'init',
      ])
    )
      throw invalid();
    if (
      (service.network_mode !== undefined && service.network_mode !== 'none') ||
      (service.read_only !== undefined && service.read_only !== true) ||
      (service.restart !== undefined && service.restart !== 'no') ||
      (service.stdin_open !== undefined && service.stdin_open !== false) ||
      (service.tty !== undefined && service.tty !== false) ||
      (service.init !== undefined && service.init !== true) ||
      (service.cap_drop !== undefined && (!Array.isArray(service.cap_drop) || service.cap_drop.length !== 1 || service.cap_drop[0] !== 'ALL'))
    )
      throw invalid();
    let expandedBytes = 0;
    const charge = (value: string) => {
      expandedBytes += Buffer.byteLength(value);
      if (expandedBytes > 512 * 1024) throw invalid();
    };
    const interpolate = (input: unknown, limit = 65536) => {
      if (!text(input, limit)) throw invalid();
      const result = interpolateAppMigration(input, environment);
      if (!text(result, limit)) throw invalid();
      charge(result);
      return result;
    };
    const image = interpolate(service.image, 1024);
    if (
      !image ||
      /\s|\$/.test(image) ||
      Array.from(image).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      image.startsWith('-')
    )
      throw invalid();
    const execution = (input: unknown) => {
      if (!Array.isArray(input) || input.length > 256 || input.some((entry) => typeof entry !== 'string')) throw invalid();
      return Object.freeze(input.map((entry) => interpolate(entry, appMigrationFileLimit)));
    };
    const user = service.user === undefined ? undefined : interpolate(typeof service.user === 'number' ? String(service.user) : service.user, 129);
    if (user !== undefined && !/^(?:[a-z_][a-z0-9_-]{0,63}|[0-9]{1,10})(?::(?:[a-z_][a-z0-9_-]{0,63}|[0-9]{1,10}))?$/.test(user)) throw invalid();
    if (user?.split(':').some((part) => /^[0-9]+$/.test(part) && Number(part) > 4294967295)) throw invalid();
    const workingDirectory = service.working_dir === undefined ? undefined : interpolate(service.working_dir, 4096);
    if (workingDirectory !== undefined && !canonical(workingDirectory)) throw invalid();
    const platform = service.platform === undefined ? undefined : interpolate(service.platform, 128);
    if (platform !== undefined && !/^linux\/(?:amd64|arm64)(?:\/[a-zA-Z0-9_.-]{1,32})?$/.test(platform)) throw invalid();
    const exported: Record<string, string> = {};
    const exportValue = (key: string, value: unknown) => {
      if (!variable.test(key) || Object.hasOwn(exported, key)) throw invalid();
      const replacement = value === null ? environment.get(key) : interpolate(typeof value === 'number' ? String(value) : value);
      if (value === null && replacement !== undefined) charge(replacement);
      if (replacement !== undefined) Object.defineProperty(exported, key, { value: replacement, enumerable: true });
    };
    if (Array.isArray(service.environment)) {
      if (service.environment.length > 1024) throw invalid();
      const names = new Set<string>();
      for (const item of service.environment) {
        const value = interpolate(item);
        const separator = value.indexOf('=');
        const key = separator < 0 ? value : value.slice(0, separator);
        if (names.has(key)) throw invalid();
        names.add(key);
        // Interpolation has already happened, so values containing dollars stay literal.
        if (!variable.test(key)) throw invalid();
        const resolved = separator < 0 ? environment.get(key) : value.slice(separator + 1);
        if (separator < 0 && resolved !== undefined) charge(resolved);
        if (resolved !== undefined) Object.defineProperty(exported, key, { value: resolved, enumerable: true });
      }
    } else if (service.environment !== undefined) {
      if (!plain(service.environment) || Object.keys(service.environment).length > 1024) throw invalid();
      for (const [key, value] of Object.entries(service.environment)) exportValue(key, value);
    }
    const mounts: { source: string; target: string; readOnly: boolean }[] = [];
    const temporary: { target: string; sizeBytes: number; mode: number; uid?: number; gid?: number }[] = [];
    const addTemporary = (destination: string, options: string[]) => {
      if (
        !target(destination) ||
        mounts.some((prior) => overlap(prior.target, destination)) ||
        temporary.some((prior) => overlap(prior.target, destination)) ||
        temporary.length >= 32 ||
        new Set(options).size !== options.length
      )
        throw invalid();
      let sizeBytes = 64 * 1024 * 1024;
      let mode = 0o1777;
      const owners: { uid?: number; gid?: number } = {};
      const selected = new Set<string>();
      for (const option of options) {
        if (['rw', 'nosuid', 'nodev', 'noexec'].includes(option)) continue;
        const terms = option.split('=');
        const [key, value] = terms;
        if (terms.length !== 2 || !key || !value || selected.has(key)) throw invalid();
        selected.add(key);
        if (key === 'mode' && /^[0-7]{3,4}$/.test(value)) mode = Number.parseInt(value, 8);
        else if (key === 'size' && /^[0-9]+[kmg]?$/i.test(value)) {
          const suffix = value.slice(-1).toLowerCase();
          sizeBytes = Number.parseInt(value, 10) * (suffix === 'k' ? 1024 : suffix === 'm' ? 1024 ** 2 : suffix === 'g' ? 1024 ** 3 : 1);
        } else if ((key === 'uid' || key === 'gid') && /^(?:0|[1-9][0-9]{0,9})$/.test(value) && Number(value) <= 4294967295)
          owners[key] = Number(value);
        else throw invalid();
      }
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 4096 || sizeBytes > 256 * 1024 * 1024 || mode > 0o1777) throw invalid();
      temporary.push(Object.freeze({ target: destination, sizeBytes, mode, ...owners }));
    };
    if (service.volumes !== undefined && (!Array.isArray(service.volumes) || service.volumes.length > 64)) throw invalid();
    for (const entry of (service.volumes ?? []) as unknown[]) {
      let host: string;
      let destination: string;
      let readOnly = false;
      if (typeof entry === 'string') {
        const parts = interpolate(entry, 8192).split(':');
        if (parts.length !== 2 && parts.length !== 3) throw invalid();
        host = parts[0] ?? '';
        destination = parts[1] ?? '';
        if (parts.length === 3 && parts[2] !== 'ro' && parts[2] !== 'rw') throw invalid();
        readOnly = parts[2] === 'ro';
      } else if (plain(entry) && entry.type === 'tmpfs') {
        if (
          !permitted(entry, ['type', 'target', 'tmpfs', 'read_only']) ||
          (entry.read_only !== undefined && entry.read_only !== false) ||
          (entry.tmpfs !== undefined && (!plain(entry.tmpfs) || !permitted(entry.tmpfs, ['size', 'mode'])))
        )
          throw invalid();
        const options: string[] = [];
        if (plain(entry.tmpfs)) {
          if (entry.tmpfs.size !== undefined) {
            if (typeof entry.tmpfs.size !== 'number' && typeof entry.tmpfs.size !== 'string') throw invalid();
            options.push('size=' + interpolate(String(entry.tmpfs.size)));
          }
          if (entry.tmpfs.mode !== undefined) {
            if (!Number.isInteger(entry.tmpfs.mode) || Number(entry.tmpfs.mode) < 0) throw invalid();
            options.push('mode=' + Number(entry.tmpfs.mode).toString(8).padStart(3, '0'));
          }
        }
        addTemporary(interpolate(entry.target, 4096), options);
        continue;
      } else {
        if (
          !plain(entry) ||
          !permitted(entry, ['type', 'source', 'target', 'read_only', 'bind']) ||
          entry.type !== 'bind' ||
          (entry.read_only !== undefined && typeof entry.read_only !== 'boolean')
        )
          throw invalid();
        if (
          entry.bind !== undefined &&
          (!plain(entry.bind) ||
            !permitted(entry.bind, ['create_host_path', 'propagation']) ||
            (entry.bind.create_host_path !== undefined && entry.bind.create_host_path !== false) ||
            (entry.bind.propagation !== undefined && entry.bind.propagation !== 'rprivate'))
        )
          throw invalid();
        host = interpolate(entry.source, 4096);
        destination = interpolate(entry.target, 4096);
        readOnly = entry.read_only === true;
      }
      if (
        !canonical(host) ||
        !inside(context.appDataHostPath, host) ||
        !target(destination) ||
        mounts.some((prior) => overlap(prior.target, destination)) ||
        temporary.some((prior) => overlap(prior.target, destination))
      )
        throw invalid();
      mounts.push(Object.freeze({ source: host, target: destination, readOnly }));
    }
    const entries = service.tmpfs === undefined ? [] : typeof service.tmpfs === 'string' ? [service.tmpfs] : service.tmpfs;
    if (!Array.isArray(entries) || entries.length > 32) throw invalid();
    for (const input of entries) {
      const parts = interpolate(input, 4096).split(':');
      if (parts.length > 2) throw invalid();
      addTemporary(parts[0] ?? '', parts[1]?.split(',') ?? []);
    }
    // Writable scratch space is required by ordinary non-root migration images
    // while the runner's image filesystem remains read-only.
    if (![...mounts, ...temporary].some((entry) => overlap(entry.target, '/tmp'))) addTemporary('/tmp', []);
    const result = {
      id: source.id,
      sourceSha256: source.sha256,
      image,
      ...(user === undefined ? {} : { user }),
      ...(service.entrypoint === undefined ? {} : { entrypoint: execution(service.entrypoint) }),
      ...(service.command === undefined ? {} : { command: execution(service.command) }),
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
      ...(platform === undefined ? {} : { platform }),
      environment: Object.freeze(exported),
      mounts: Object.freeze(mounts),
      temporary: Object.freeze(temporary),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw invalid();
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof Error && error.message === incomplete().message) throw incomplete();
    throw invalid();
  }
}

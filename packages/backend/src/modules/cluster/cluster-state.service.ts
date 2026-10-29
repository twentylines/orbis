import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { type } from 'arktype';
import { ConfigurationService } from '@/core/config/configuration.service';
import { clusterOrigin, CLUSTER_PROTOCOL, digest, equalSecret, signedHeaders } from './cluster-transport';
import { clusterCertificateTrustSchema } from './cluster-certificate';

const peerSchema = type({
  id: 'string',
  name: 'string',
  url: 'string',
  secret: 'string',
  insecureLan: 'boolean',
  'tls?': clusterCertificateTrustSchema,
});
const stateSchema = type({
  version: '1',
  id: 'string',
  name: 'string',
  role: "'standalone'|'admin'|'member'",
  serverName: 'string',
  'admin?': { id: 'string', name: 'string', secret: 'string' },
  peers: peerSchema.array().atMostLength(12),
  'invite?': { hash: 'string', expiresAt: 'number' },
  nonces: type({ value: 'string', expiresAt: 'number' }).array(),
});
export type ClusterState = typeof stateSchema.infer;
export type ClusterPeer = typeof peerSchema.infer;
export function clusterName(value: unknown, fallback?: string): string {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 64 || /\p{Cc}/u.test(value)) {
    throw new BadRequestException('Use a name between 1 and 64 characters.');
  }
  return value.trim();
}

@Injectable()
export class ClusterStateService {
  private queue: Promise<unknown> = Promise.resolve();
  private cached: ClusterState | null = null;
  constructor(private readonly config: ConfigurationService) {}

  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'cluster.json');
  }

  private async load(): Promise<ClusterState> {
    try {
      const value = stateSchema(JSON.parse(await fs.readFile(this.file(), 'utf8')));
      if (value instanceof type.errors) throw new Error('Invalid cluster state. Restore the private cluster configuration.');
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const settings = this.config.get('userSettings');
      return {
        version: 1,
        id: randomUUID(),
        name: 'My cluster',
        role: 'standalone',
        serverName: settings.localDomain || 'Local server',
        peers: [],
        nonces: [],
      };
    }
  }

  async transaction<T>(operation: (state: ClusterState) => Promise<T> | T): Promise<T> {
    const pending = this.queue.then(async () => {
      const state = structuredClone(this.cached ?? (await this.load()));
      const before = JSON.stringify(state);
      const result = await operation(state);
      if (this.cached && JSON.stringify(state) === before) return result;
      const file = this.file();
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(state)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, file);
        const directory = await fs.open(path.dirname(file), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await fs.rm(temporary, { force: true });
      }
      this.cached = structuredClone(state);
      return result;
    });
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  read() {
    return this.transaction((state) => structuredClone(state));
  }

  async describe() {
    const state = await this.read();
    return {
      id: state.id,
      localId: state.id,
      name: state.name,
      role: state.role,
      ...(state.admin ? { admin: { id: state.admin.id, name: state.admin.name } } : {}),
      servers: [
        { id: state.id, name: state.serverName, url: '', role: state.role === 'admin' ? 'admin' : 'member', local: true },
        ...state.peers.map(({ id, name, url, tls }) => ({
          id,
          name,
          url,
          role: 'member',
          local: false,
          ...(tls ? { certificateSha256: tls.sha256 } : {}),
        })),
      ],
    };
  }

  create(name: unknown, serverName?: unknown) {
    return this.transaction((state) => {
      if (state.role === 'member') throw new ConflictException('Leave this cluster before creating another.');
      state.name = clusterName(name);
      state.serverName = clusterName(serverName, state.serverName);
      state.role = 'admin';
      delete state.invite;
      return { created: true };
    });
  }

  invite() {
    return this.transaction((state) => {
      if (state.role !== 'standalone') throw new ConflictException('This server already belongs to a cluster. Leave it before pairing.');
      const code = randomBytes(12).toString('hex').toUpperCase();
      const expiresAt = Date.now() + 5 * 60_000;
      state.invite = { hash: digest(code), expiresAt };
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  accept(body: Record<string, unknown>) {
    return this.transaction((state) => {
      if (
        body.protocol !== CLUSTER_PROTOCOL ||
        state.role !== 'standalone' ||
        !state.invite ||
        state.invite.expiresAt < Date.now() ||
        typeof body.code !== 'string' ||
        !equalSecret(digest(body.code.toUpperCase().replace(/\s/g, '')), state.invite.hash) ||
        typeof body.adminId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(body.adminId) ||
        body.adminId === state.id ||
        typeof body.secret !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.secret)
      )
        throw new UnauthorizedException('Pairing code is invalid, expired or already used.');
      state.name = clusterName(body.clusterName);
      state.serverName = clusterName(body.name, state.serverName);
      state.admin = { id: body.adminId, name: clusterName(body.adminName), secret: body.secret };
      state.role = 'member';
      state.nonces = [];
      delete state.invite;
      return { protocol: CLUSTER_PROTOCOL, id: state.id, name: state.serverName };
    });
  }

  async authorize(headers: Record<string, unknown>, body: object) {
    return this.transaction((state) => {
      const id = headers['x-orbis-server'];
      const timestamp = headers['x-orbis-time'];
      const nonce = headers['x-orbis-nonce'];
      const signature = headers['x-orbis-signature'];
      if (
        state.role !== 'member' ||
        !state.admin ||
        id !== state.admin.id ||
        typeof timestamp !== 'string' ||
        !/^\d{13}$/.test(timestamp) ||
        Math.abs(Date.now() - Number(timestamp)) > 60_000 ||
        typeof nonce !== 'string' ||
        !/^[a-f0-9]{48}$/.test(nonce) ||
        typeof signature !== 'string' ||
        !equalSecret(signature, signedHeaders(state.admin.id, state.admin.secret, JSON.stringify(body), timestamp, nonce)['x-orbis-signature'])
      )
        throw new UnauthorizedException('Invalid cluster signature.');
      state.nonces = state.nonces.filter((entry) => entry.expiresAt > Date.now());
      if (state.nonces.length >= 512 || state.nonces.some((entry) => entry.value === nonce))
        throw new UnauthorizedException('Cluster request has already been used or rate limited.');
      state.nonces.push({ value: nonce, expiresAt: Date.now() + 120_000 });
      return true;
    });
  }

  leave() {
    return this.transaction((state) => {
      if (state.peers.length) throw new ConflictException('Remove paired servers before deleting this cluster.');
      state.role = 'standalone';
      delete state.admin;
      delete state.invite;
      state.nonces = [];
      return { left: true };
    });
  }

  validatePeerUrl(url: unknown, insecureLan: boolean) {
    return clusterOrigin(url, insecureLan).origin;
  }
}

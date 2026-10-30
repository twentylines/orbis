import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsService } from '../apps/apps.service';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { SystemService } from '../system/system.service';
import { OrbisReleaseService } from '../system/orbis-release.service';
import { ContainerTelemetryService } from '../system/container-telemetry.service';
import { MetricHistoryService } from '../system/metric-history.service';
import { HostTelemetryService } from '../system/host-telemetry.service';
import { HostProcessesService } from '../system/host-processes.service';
import { HostSensorsService } from '../system/host-sensors.service';
import { DriveHealthService } from '../system/drive-health.service';
import { HostDeviceHistoryService } from '../system/host-device-history.service';
import { parseHostHistorySelection } from '../system/host-device-history.model';
import { metricHistoryRanges, type MetricHistoryRange } from '@runtipi/common/schemas';
import { HostUpdatesService } from '../host-updates/host-updates.service';
import { DockerAppsService } from '../docker-apps/docker-apps.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { castAppUrn } from '@/common/helpers/app-helpers';
import { ClusterStateService, clusterName } from './cluster-state.service';
import { CLUSTER_PROTOCOL, clusterRequest, signedHeaders } from './cluster-transport';
import { ClusterInstallService } from './cluster-install.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { AuthService } from '../auth/auth.service';
import { bindClusterCertificate, clusterCertificate, pairedClusterCertificate } from './cluster-certificate';

@Injectable()
export class ClusterService {
  constructor(
    private readonly state: ClusterStateService,
    private readonly config: ConfigurationService,
    private readonly apps: AppsService,
    private readonly lifecycle: AppLifecycleService,
    private readonly system: SystemService,
    private readonly releases: OrbisReleaseService,
    private readonly containers: ContainerTelemetryService,
    private readonly history: MetricHistoryService,
    private readonly host: HostTelemetryService,
    private readonly processes: HostProcessesService,
    private readonly sensors: HostSensorsService,
    private readonly hostHistory: HostDeviceHistoryService,
    private readonly updates: HostUpdatesService,
    private readonly dockerApps: DockerAppsService,
    private readonly marketplace: MarketplaceService,
    private readonly installs: ClusterInstallService,
    private readonly activity: MonitoringActivityService,
    private readonly drives: DriveHealthService,
    private readonly auth: AuthService,
  ) {}

  private fields(body: unknown, allowed: string[]): asserts body is Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
      throw new BadRequestException('Provide only the requested pairing details.');
  }

  private async approveTrust(userId: number, body: Record<string, unknown>) {
    if (
      !Number.isSafeInteger(userId) ||
      userId <= 0 ||
      typeof body.password !== 'string' ||
      !body.password ||
      body.password.length > 1024 ||
      (body.totpCode !== undefined && (typeof body.totpCode !== 'string' || !/^\d{6}$/.test(body.totpCode)))
    )
      throw new BadRequestException('Confirm pairing with your account password and authentication code if enabled.');
    const user = await this.auth.verifySensitiveAction(userId, body.password, body.totpCode as string | undefined);
    if (user.operator !== true) throw new ForbiddenException('An operator account is required for pairing.');
  }

  async invite(body: Record<string, unknown>, userId: number) {
    this.fields(body, ['password', 'totpCode']);
    await this.approveTrust(userId, body);
    try {
      return await this.state.invite(userId);
    } catch (error) {
      if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EIO'].includes((error as NodeJS.ErrnoException)?.code ?? ''))
        throw new ServiceUnavailableException('The pairing code could not be saved. Check server storage permissions and free space.');
      throw error;
    }
  }

  async pair(body: Record<string, unknown>, userId: number) {
    this.fields(body, [
      'password',
      'totpCode',
      'url',
      'code',
      'name',
      'allowInsecureLan',
      'peerCertificatePem',
      'peerCertificateSha256',
      'confirmPeerCertificate',
    ]);
    await this.approveTrust(userId, body);
    const certificate = clusterCertificate(body);
    const current = await this.state.read();
    if (current.role !== 'admin') throw new ForbiddenException('Create a cluster on its admin server first.');
    if (current.peers.length >= 12) throw new ConflictException('A cluster supports up to 12 paired servers.');
    const insecureLan = body.allowInsecureLan === true;
    const url = this.state.validatePeerUrl(body.url, insecureLan);
    if (current.peers.some((peer) => peer.url === url)) throw new ConflictException('This address is already paired.');
    const code = typeof body.code === 'string' ? body.code.toUpperCase().replace(/\s/g, '') : '';
    if (!/^[A-F0-9]{24}$/.test(code)) throw new BadRequestException('Enter the 24-character pairing code from the joining server.');
    const secret = randomBytes(32).toString('hex');
    const result = await clusterRequest<{ protocol: string; id: string; name: string }>(
      url,
      '/api/cluster/accept',
      {
        protocol: CLUSTER_PROTOCOL,
        code,
        secret,
        adminId: current.id,
        adminName: current.serverName,
        clusterName: current.name,
        ...(body.name ? { name: clusterName(body.name) } : {}),
      },
      {},
      insecureLan,
      certificate,
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      result.protocol !== CLUSTER_PROTOCOL ||
      typeof result.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(result.id) ||
      result.id === current.id
    ) {
      throw new ConflictException('This server does not support the cluster protocol or is the admin server itself.');
    }
    const name = clusterName(result.name);
    await this.state.transaction((state) => {
      if (
        state.role !== 'admin' ||
        state.id !== current.id ||
        state.peers.length >= 12 ||
        state.peers.some((peer) => peer.id === result.id || peer.url === url)
      ) {
        throw new ConflictException('Cluster membership changed while pairing. Leave the cluster on the joining server and try again.');
      }
      state.peers.push({
        id: result.id,
        name,
        url,
        secret,
        insecureLan,
        ...(certificate ? { tls: bindClusterCertificate(certificate, current.id, result.id, url, secret) } : {}),
      });
    });
    return { paired: true, id: result.id, name, ...(certificate ? { certificateSha256: certificate.sha256 } : {}) };
  }

  private async send<T>(id: string, body: object): Promise<T> {
    const state = await this.state.read();
    if (state.role !== 'admin') throw new ForbiddenException('Only the cluster admin server can control paired hosts.');
    const peer = state.peers.find((entry) => entry.id === id);
    if (!peer) throw new NotFoundException('Paired server not found.');
    const envelope = { ...body, clusterName: state.name, adminName: state.serverName };
    return clusterRequest<T>(
      peer.url,
      '/api/cluster/peer',
      envelope,
      signedHeaders(state.id, peer.secret, JSON.stringify(envelope)),
      peer.insecureLan,
      pairedClusterCertificate(state.id, peer),
    );
  }

  async remove(id: string, forget = false) {
    // A failed revocation stays visible so it can be retried; no silent orphaned trust.
    if (!forget) await this.send(id, { action: 'leave' });
    await this.state.transaction((state) => {
      if (state.role !== 'admin') throw new ForbiddenException('Only the admin server can remove members.');
      if (!state.peers.some((entry) => entry.id === id)) throw new NotFoundException('Paired server not found.');
      state.peers = state.peers.filter((entry) => entry.id !== id);
    });
    return { removed: true, remoteRevoked: !forget };
  }

  async read(id: string, resource: string, params: Record<string, unknown> = {}) {
    const state = await this.state.read();
    if (id !== state.id) return this.send(id, { action: 'read', resource, params });
    return this.localRead(resource, params);
  }

  async command(id: string, action: string, payload: Record<string, unknown> = {}) {
    const state = await this.state.read();
    if (state.role === 'member') throw new ForbiddenException('Use the admin server for cluster commands.');
    if (id !== state.id) return this.send(id, { action: 'command', command: action, payload });
    return this.localCommand(action, payload);
  }

  async peer(headers: Record<string, unknown>, body: Record<string, unknown>) {
    await this.state.authorize(headers, body);
    await this.state.transaction((state) => {
      state.name = clusterName(body.clusterName, state.name);
      if (state.admin) state.admin.name = clusterName(body.adminName, state.admin.name);
    });
    if (body.action === 'leave') return this.state.leave();
    if (body.action === 'read' && typeof body.resource === 'string') return this.localRead(body.resource, this.record(body.params), true);
    if (body.action === 'command' && typeof body.command === 'string') return this.localCommand(body.command, this.record(body.payload));
    throw new BadRequestException('Unsupported cluster request.');
  }

  private record(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Invalid cluster parameters.');
    return value as Record<string, unknown>;
  }

  private range(value: unknown): MetricHistoryRange {
    if (typeof value !== 'string' || !Object.hasOwn(metricHistoryRanges, value)) throw new BadRequestException('Unsupported history range.');
    return value as MetricHistoryRange;
  }

  private async localRead(resource: string, params: Record<string, unknown>, peer = false) {
    const range = resource === 'history' || resource === 'host-history' ? this.range(params.range ?? '1h') : '1h';
    const selection = resource === 'host-history' ? parseHostHistorySelection(params.device) : null;
    if (peer && ['telemetry', 'containers', 'history', 'host-telemetry', 'host-processes', 'host-sensors', 'host-history'].includes(resource))
      this.activity.touchPeer();
    switch (resource) {
      case 'catalogue':
        return this.installs.catalogue(params);
      case 'install-context':
        return this.installs.context(params);
      case 'install-port':
        return this.installs.randomPort();
      case 'icon': {
        if (typeof params.urn !== 'string' || params.urn.length > 256) throw new BadRequestException('Choose one app icon.');
        const { image } = await this.marketplace.getAppImage(castAppUrn(params.urn));
        if (!image || image.length > 1024 * 1024) throw new NotFoundException('App icon unavailable.');
        const mime = image.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
          ? 'image/jpeg'
          : image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? 'image/png'
            : image.subarray(0, 4).toString() === 'RIFF' && image.subarray(8, 12).toString() === 'WEBP'
              ? 'image/webp'
              : null;
        if (!mime) throw new NotFoundException('Unsupported app icon format.');
        return { dataUrl: `data:${mime};base64,${image.toString('base64')}` };
      }
      case 'telemetry':
        return this.system.getTelemetry();
      case 'containers':
        return this.containers.read();
      case 'docker-apps':
        return this.dockerApps.read();
      case 'history':
        return this.history.read(range);
      case 'host-telemetry':
        return this.host.read();
      case 'host-processes':
        return this.processes.read();
      case 'host-sensors':
        return this.sensors.read();
      case 'drives':
        return this.drives.read();
      case 'host-history':
        return this.hostHistory.read(range, selection);
      case 'apps': {
        const settings = this.config.get('userSettings');
        return {
          installed: (await this.apps.getInstalledApps()).map(({ app, info, metadata }) => ({
            app: {
              id: app.id,
              createdAt: app.createdAt,
              status: app.status,
              version: app.version,
              ignoredVersion: app.ignoredVersion,
              port: app.port,
              openPort: app.openPort,
              exposed: app.exposed,
              exposedLocal: app.exposedLocal,
              domain: app.domain,
            },
            info: {
              urn: info.urn,
              name: info.name,
              available: info.available,
              categories: info.categories,
              no_gui: info.no_gui,
              url_suffix: info.url_suffix,
              port: info.port,
              https: info.https,
              dynamic_config: info.dynamic_config,
            },
            metadata: { latestVersion: metadata.latestVersion, localSubdomain: metadata.localSubdomain },
          })),
          addresses: { localDomain: settings.localDomain, sslPort: settings.sslPort },
        };
      }
      case 'build':
        return { version: process.env.ORBIS_VERSION || 'development', commit: process.env.ORBIS_COMMIT || null };
      case 'release':
        return this.releases.latest();
      case 'update-status':
        return this.updates.status();
      default:
        throw new BadRequestException('Unsupported cluster resource.');
    }
  }

  private async localCommand(action: string, payload: Record<string, unknown>) {
    switch (action) {
      case 'install-app':
        return this.installs.install(payload);
      case 'update-apps': {
        const apps = (await this.apps.getInstalledApps()).filter(
          ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
        );
        const results: { urn: string; accepted: boolean }[] = [];
        for (const { info } of apps) {
          try {
            await this.lifecycle.updateApp({ appUrn: castAppUrn(info.urn), performBackup: true });
            results.push({ urn: info.urn, accepted: true });
          } catch {
            results.push({ urn: info.urn, accepted: false });
          }
        }
        return { results, queued: results.filter((item) => item.accepted).length, failed: results.filter((item) => !item.accepted).length };
      }
      case 'plan-orbis':
        return this.updates.plan(payload.tag);
      case 'apply-orbis':
        return this.updates.apply(payload.planId);
      case 'drive-self-test':
        if (Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'id') || !Object.hasOwn(payload, 'kind')) {
          throw new BadRequestException('Choose one drive and a supported self-test.');
        }
        return this.updates.driveTest(payload.id, payload.kind);
      default:
        throw new BadRequestException('Unsupported cluster command.');
    }
  }
}

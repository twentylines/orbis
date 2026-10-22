import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { type } from 'arktype';
import validator from 'validator';
import type { AppInfo } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { castAppUrn, extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { TranslatableError } from '@/common/error/translatable-error';
import { AppStoreRepository } from '../app-stores/app-store.repository';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { AppLifecycleService } from '../app-lifecycle/app-lifecycle.service';
import { appFormSchema } from '../app-lifecycle/dto/app-lifecycle.dto';

const baseFields = new Set([
  'port',
  'exposed',
  'exposedLocal',
  'openPort',
  'domain',
  'isVisibleOnGuestDashboard',
  'enableAuth',
  'localSubdomain',
  'maxBackups',
  'forcePull',
]);
const reservedFields = new Set(['skipEnv', 'skipPull', 'skipRun', '__proto__', 'prototype', 'constructor']);

function text(value: unknown, name: string, maximum: number, optional = false): string | undefined {
  if (optional && (value === undefined || value === '')) return undefined;
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maximum ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new BadRequestException(`Invalid ${name}.`);
  }
  return value;
}

function storeOrigin(value: unknown): string {
  const input = text(value, 'app store address', 2048);
  try {
    const url = new URL(input ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
  } catch {
    throw new BadRequestException('Use an app store already configured on the selected server.');
  }
}

@Injectable()
export class ClusterInstallService {
  constructor(
    private readonly config: ConfigurationService,
    private readonly stores: AppStoreRepository,
    private readonly apps: AppsRepository,
    private readonly ports: AppsService,
    private readonly marketplace: MarketplaceService,
    private readonly lifecycle: AppLifecycleService,
  ) {}

  async catalogue(params: Record<string, unknown>) {
    const search = text(params.search, 'search', 160, true);
    const cursor = text(params.cursor, 'catalogue cursor', 256, true);
    const result = await this.marketplace.searchApps({ search, cursor, pageSize: 24 });
    return {
      ...result,
      data: result.data.map(({ urn, name, short_desc, categories }) => ({ urn, name, short_desc, categories })),
    };
  }

  private async resolve(params: Record<string, unknown>) {
    const enabled = await this.stores.getEnabledAppStores();
    let urn: AppUrn | undefined;
    let store: (typeof enabled)[number] | undefined;
    if (params.urn !== undefined) {
      const value = text(params.urn, 'app identifier', 256);
      try {
        urn = castAppUrn(value ?? '');
      } catch {
        throw new BadRequestException('Choose an app from the selected server’s catalogue.');
      }
      const { appStoreId } = extractAppUrn(urn);
      store = enabled.find(({ slug }) => slug === appStoreId);
    } else {
      const appName = text(params.appName, 'app name', 128);
      if (!/^[a-zA-Z0-9_-]+$/.test(appName ?? '')) throw new BadRequestException('Invalid app name.');
      const origin = storeOrigin(params.storeUrl);
      const branch = text(params.branch, 'app store branch', 256);
      const matches = enabled.filter((entry) => {
        try {
          return storeOrigin(entry.url) === origin && entry.branch === branch;
        } catch {
          return false;
        }
      });
      if (matches.length > 1)
        throw new ConflictException('More than one matching app store is configured on this server. Choose the app from its catalogue.');
      store = matches[0];
      if (store) urn = castAppUrn(`${appName}:${store.slug}`);
    }
    if (!store || !urn) throw new NotFoundException('The app’s store is not enabled on the selected server.');
    const info = await this.marketplace.getAppInfoFromAppStore(urn);
    if (!info || !info.available || info.deprecated) throw new NotFoundException('This app is unavailable on the selected server.');
    const { architecture } = this.config.getConfig();
    if (info.supported_architectures.length && !info.supported_architectures.includes(architecture)) {
      throw new BadRequestException('This app does not support the selected server’s architecture.');
    }
    if (Buffer.byteLength(JSON.stringify(info)) > 512 * 1024)
      throw new BadRequestException('This app’s configuration is too large to load remotely.');
    return { urn, info, source: { appName: extractAppUrn(urn).appName, storeUrl: storeOrigin(store.url), branch: store.branch } };
  }

  async context(params: Record<string, unknown>) {
    const { urn, info, source } = await this.resolve(params);
    const settings = this.config.get('userSettings');
    return {
      info,
      source,
      installed: !!(await this.apps.getAppByUrn(urn)),
      settings: {
        guestDashboard: settings.guestDashboard,
        localDomain: settings.localDomain,
        internalIp: settings.internalIp,
        domain: settings.domain,
        maxBackups: settings.maxBackups,
      },
    };
  }

  async randomPort() {
    return { port: await this.ports.getRandomPort() };
  }

  private form(info: AppInfo, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
      throw new BadRequestException('Check the app configuration.');
    }
    const fields = info.form_fields.filter((field) => field.type !== 'random');
    const allowed = new Set([...baseFields, ...fields.map((field) => field.env_variable)]);
    for (const [key, entry] of Object.entries(value)) {
      if (reservedFields.has(key) || !allowed.has(key) || (entry !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof entry))) {
        throw new BadRequestException('The app configuration contains an unsupported field.');
      }
    }
    const parsed = appFormSchema(value);
    if (parsed instanceof type.errors || (parsed.port !== undefined && !Number.isInteger(parsed.port))) {
      throw new BadRequestException('Check the app port, domain and backup settings.');
    }
    for (const field of fields) {
      const entry = parsed[field.env_variable];
      const label = field.label.slice(0, 100);
      const empty = entry === undefined || entry === null || entry === '';
      if (empty) {
        if (field.required) throw new BadRequestException(`${label} is required.`);
        continue;
      }
      if (field.type === 'boolean') {
        if (typeof entry !== 'boolean') throw new BadRequestException(`Check ${label}.`);
        continue;
      }
      if (typeof entry !== 'string' && !(field.type === 'number' && typeof entry === 'number' && Number.isFinite(entry))) {
        throw new BadRequestException(`Check ${label}.`);
      }
      const content = String(entry);
      let valid = true;
      if (field.type === 'number') {
        valid =
          validator.isNumeric(content) &&
          Number.isFinite(Number(content)) &&
          (field.min === undefined || Number(content) >= field.min) &&
          (field.max === undefined || Number(content) <= field.max);
      } else if (field.type === 'text' || field.type === 'password') {
        valid = content.length >= (field.min ?? 0) && content.length <= (field.max ?? (field.type === 'password' ? 100 : 64 * 1024));
      } else if (field.type === 'email') valid = validator.isEmail(content);
      else if (field.type === 'fqdn') valid = validator.isFQDN(content);
      else if (field.type === 'ip') valid = validator.isIP(content);
      else if (field.type === 'fqdnip') valid = validator.isFQDN(content) || validator.isIP(content);
      else if (field.type === 'url') valid = validator.isURL(content);
      if (field.options?.length && !field.options.some((option) => option.value === content)) valid = false;
      if (field.regex && !validator.matches(content, field.regex)) valid = false;
      if (!valid) throw new BadRequestException(`Check ${label}.`);
    }
    return parsed;
  }

  async install(payload: Record<string, unknown>) {
    const { urn, info } = await this.resolve(payload);
    const form = this.form(info, payload.form);
    try {
      const result = await this.lifecycle.installApp({ appUrn: urn, form, requireNew: true });
      return { ...result, urn, accepted: true as const };
    } catch (error) {
      if (error instanceof ConflictException) {
        return { accepted: false as const, message: 'This app is already installed on the selected server.' };
      }
      if (error instanceof TranslatableError) {
        const messages: Record<string, string> = {
          APP_ERROR_PORT_ALREADY_IN_USE: 'That port is already in use on the selected server. Choose another port.',
          APP_ERROR_DOMAIN_ALREADY_IN_USE: 'That domain is already in use on the selected server.',
          APP_ERROR_LOCAL_SUBDOMAIN_ALREADY_IN_USE: 'That local subdomain is already in use on the selected server.',
          APP_ERROR_DOMAIN_REQUIRED_IF_EXPOSE_APP: 'Enter a domain for the exposed app.',
          APP_ERROR_DOMAIN_NOT_VALID: 'Enter a valid domain for the app.',
          APP_UPDATE_ERROR_MIN_TIPI_VERSION: 'Update the selected server before installing this app.',
          APP_ERROR_ARCHITECTURE_NOT_SUPPORTED: 'This app does not support the selected server’s architecture.',
          APP_ERROR_APP_FORCE_EXPOSED: 'This app requires a domain and reverse proxy access.',
        };
        const response = error.getResponse() as { message?: string };
        return {
          accepted: false as const,
          message:
            messages[response.message ?? ''] ?? 'The selected server could not accept this configuration. Check its app settings and try again.',
        };
      }
      throw error;
    }
  }
}

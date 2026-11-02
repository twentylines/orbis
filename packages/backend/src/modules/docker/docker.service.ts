import { spawn } from 'node:child_process';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import * as Sentry from '@sentry/nestjs';
import { parse } from 'yaml';
import {
  type AppImagePinInput,
  beginAppImagePinUpdate,
  requireAppImagePinUpdate,
  requireNoAppImagePinUpdates,
  appImagePinSourceSha256,
  readAppImagePins,
  writeAppImagePins,
  removeAppImagePins,
} from './app-image-pins';
import { AppFilesManager } from '../apps/app-files-manager';
import { AppsService } from '../apps/apps.service';

@Injectable()
export class DockerService {
  constructor(
    private readonly logger: LoggerService,
    private readonly config: ConfigurationService,
    private readonly appFilesManager: AppFilesManager,
    private readonly filesystem: FilesystemService,
    private readonly appsService: AppsService,
  ) {}

  private imagePinDirectory() {
    return path.join(this.config.get('directories').dataDir, 'state', 'time-machine', 'image-pins');
  }

  public async getAppImagePinSource(appUrn: AppUrn, transactionId?: string) {
    await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    const { app } = await this.appsService.getApp(appUrn);
    const source = await this.appFilesManager.getSourceDockerComposeYaml(appUrn);
    const user = await this.appFilesManager.getUserComposeFile(appUrn);
    return {
      appUrn,
      project: appUrn.replace(':', '_'),
      sourceSha256: appImagePinSourceSha256(source.content, (app?.userConfigEnabled ?? true) ? user.content : null),
    };
  }

  private async requirePinnedServices(appUrn: AppUrn, services: Record<string, string>) {
    const generated = await this.appFilesManager.getGeneratedDockerComposeYaml(appUrn);
    const user = await this.appFilesManager.getUserComposeFile(appUrn);
    const { app } = await this.appsService.getApp(appUrn);
    const expected = new Set<string>();
    for (const content of [generated.content, (app?.userConfigEnabled ?? true) ? user.content : null]) {
      if (!content) continue;
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Retained app Compose exceeds its size limit.');
      const document = parse(content);
      if (
        !document ||
        typeof document !== 'object' ||
        document.include !== undefined ||
        (document.services !== undefined && (document.services === null || typeof document.services !== 'object' || Array.isArray(document.services)))
      )
        throw new Error('Retained app services could not be verified.');
      for (const name of Object.keys(document.services ?? {})) expected.add(name);
    }
    if (!expected.size || [...expected].sort().join('\0') !== Object.keys(services).sort().join('\0'))
      throw new Error('Retained images do not cover this app configuration.');
  }

  public async readAppImagePins(appUrn: AppUrn, transactionId?: string) {
    await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    const stored = await readAppImagePins(this.imagePinDirectory(), { appUrn, project: appUrn.replace(':', '_') });
    if (!stored) return null;
    const source = await this.getAppImagePinSource(appUrn, transactionId);
    if (stored.pins.sourceSha256 !== source.sourceSha256) throw new Error('App configuration differs from its retained image pins.');
    await this.requirePinnedServices(appUrn, stored.pins.services);
    return stored;
  }

  public async writeAppImagePins(appUrn: AppUrn, input: AppImagePinInput) {
    await this.requirePinnedServices(appUrn, input.services);
    return writeAppImagePins(this.imagePinDirectory(), await this.getAppImagePinSource(appUrn), input);
  }

  public requireAppImagePinUpdate(appUrn: AppUrn, transactionId?: string) {
    return requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
  }

  public requireNoPendingAppImageUpdates() {
    return requireNoAppImagePinUpdates(this.imagePinDirectory());
  }

  public async beginRetainedAppImageUpdate(appUrn: AppUrn) {
    if (!(await this.readAppImagePins(appUrn))) throw new Error('This app has no retained image pins.');
    const { appInstalledDir, appDataDir } = this.appFilesManager.getAppPaths(appUrn);
    return beginAppImagePinUpdate(this.imagePinDirectory(), appUrn, appInstalledDir, path.join(appDataDir, 'app.env'));
  }

  public async retireAppImagePinsAfterUpdate(appUrn: AppUrn, transactionId: string) {
    const guard = await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, transactionId);
    if (guard?.phase !== 'committing') throw new Error('Retained app update has not committed.');
    await removeAppImagePins(this.imagePinDirectory(), appUrn);
  }

  /**
   * Get the base compose args for an app
   * @param {string} appUrn - App name
   */
  public getBaseComposeArgsApp = async (appUrn: AppUrn, options?: { imagePins?: 'explicit-update'; imagePinUpdate?: string }) => {
    let isCustomConfig = false;

    const appEnv = await this.appFilesManager.getAppEnv(appUrn);
    const args: string[] = ['--env-file', appEnv.path];

    const { app } = await this.appsService.getApp(appUrn);
    const userConfigEnabled = app?.userConfigEnabled ?? true;

    // User custom env file
    const userEnvFile = await this.appFilesManager.getUserEnv(appUrn);
    if (userEnvFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--env-file', userEnvFile.path);
    }

    args.push('--project-name', appUrn.replace(':', '_'));

    const composeFile = await this.appFilesManager.getGeneratedDockerComposeYaml(appUrn);
    args.push('-f', composeFile.path);

    // User defined overrides
    const userComposeFile = await this.appFilesManager.getUserComposeFile(appUrn);
    if (userComposeFile.content && userConfigEnabled) {
      isCustomConfig = true;
      args.push('--file', userComposeFile.path);
    }

    const guard = await requireAppImagePinUpdate(this.imagePinDirectory(), appUrn, options?.imagePinUpdate);
    if (options?.imagePins === 'explicit-update' && !guard) throw new Error('Explicit image replacement needs a retained app update transaction.');
    const retained = options?.imagePins === 'explicit-update' ? null : await this.readAppImagePins(appUrn, options?.imagePinUpdate);
    if (retained) args.push('--file', retained.path);
    return { args, isCustomConfig, retainedImages: Boolean(retained) };
  };

  public getBaseComposeArgsRuntipi = async () => {
    const { dataDir } = this.config.get('directories');
    const args: string[] = ['--env-file', path.join(dataDir, '.env')];

    args.push('--project-name', 'runtipi');

    const composeFile = path.join(dataDir, 'docker-compose.yml');
    args.push('-f', composeFile);

    // User defined overrides
    const userComposeFile = path.join(dataDir, 'user-config', 'tipi-compose.yml');
    if (await this.filesystem.isFile(userComposeFile)) {
      args.push('--file', userComposeFile);
    }

    return { args };
  };

  /**
   * Helpers to execute docker compose commands
   * @param {string} appUrn - App name
   * @param {string} command - Command to execute
   */
  public async composeApp(
    appUrn: AppUrn,
    command: string,
    options?: { imagePins?: 'explicit-update'; imagePinUpdate?: string; signal?: AbortSignal },
  ) {
    let { args, isCustomConfig, retainedImages } = await this.getBaseComposeArgsApp(appUrn, options);
    const operation = command.split(' ').filter(Boolean);
    if (retainedImages) {
      if (operation[0] === 'pull' || operation[0] === 'build' || operation[0] === 'run' || operation.some((part) => part === '--build'))
        throw new Error('Explicitly update this app before replacing its retained images.');
      for (let index = operation.length - 1; index >= 0; index--) {
        if (operation[index] === '--pull' || operation[index] === '--rmi') operation.splice(index, 2);
        else if (operation[index]?.startsWith('--pull=') || operation[index]?.startsWith('--rmi=')) operation.splice(index, 1);
      }
      if (operation[0] === 'up' || operation[0] === 'create') {
        if (!operation.includes('--no-build')) operation.push('--no-build');
        operation.push('--pull', 'never');
      }
    }
    args.push(...operation);
    args = args.filter(Boolean);

    this.logger.info(`Running docker compose with args ${args.join(' ')}`);

    options?.signal?.throwIfAborted();
    const cmd = spawn('docker-compose', args);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        cmd.kill('SIGTERM');
        escalation = setTimeout(() => cmd.kill('SIGKILL'), 5000);
        escalation.unref();
      };
      const cleanup = () => {
        options?.signal?.removeEventListener('abort', abort);
        if (escalation) clearTimeout(escalation);
      };
      cmd.stdout.on('data', (data) => {
        this.logger.debug(`docker-compose: ${String(data).trim()}`);
        stdout.push(String(data).trim());
      });
      cmd.stderr.on('data', (data) => {
        this.logger.debug(`docker-compose: ${String(data).trim()}`);
        stderr.push(String(data).trim());
      });
      cmd.once('error', (error) => {
        cleanup();
        reject(error);
      });
      cmd.once('close', (code) => {
        cleanup();
        if (options?.signal?.aborted) reject(options.signal.reason);
        else resolve(code);
      });
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) abort();
    });

    if (exitCode !== 0) {
      this.logger.info(`Docker-compose exited with code ${exitCode}`);
      if (isCustomConfig) {
        this.logger.warn('User-config detected, please make sure your configuration is correct before opening an issue');
      }
      const error = stderr.pop();
      throw new Error(error);
    }

    return { success: true, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  public getLogsStream = async (maxLines: number, appUrn?: AppUrn) => {
    try {
      const { args } = appUrn ? await this.getBaseComposeArgsApp(appUrn) : await this.getBaseComposeArgsRuntipi();

      args.push('logs', '--follow', '-n', maxLines.toString());

      const logs = spawn('docker-compose', args, { stdio: 'pipe' });

      logs.on('error', () => {
        logs.kill('SIGINT');
      });

      return {
        on: logs.stdout.on.bind(logs.stdout),
        kill: () => logs.kill('SIGINT'),
      };
    } catch (error) {
      this.logger.error('Error getting log stream', error);
      Sentry.captureException(error, { tags: { source: 'docker log stream', appUrn } });
      throw new InternalServerErrorException('Error getting log stream');
    }
  };
}

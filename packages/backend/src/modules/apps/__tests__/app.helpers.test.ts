import { createAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { FilesystemService } from '@/core/filesystem/filesystem.service';
import { LoggerService } from '@/core/logger/logger.service';
import { StartAppCommand } from '@/modules/app-lifecycle/commands/start-app-command';
import { DockerService } from '@/modules/docker/docker.service';
import { EnvUtils } from '@/modules/env/env.utils';
import type { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { AppInfo } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AppFilesManager } from '../app-files-manager';
import { AppHelpers } from '../app.helpers';

describe('AppHelpers', () => {
  let appHelpers: AppHelpers;
  let appFilesManager = mock<AppFilesManager>();
  let config = mock<ConfigurationService>();
  const envUtils = new EnvUtils();
  const testAppUrn: AppUrn = createAppUrn('test-app', 'test-store');
  const testAppEnv = '/app-data/test-store/test-app/app.env';
  const writtenEnv = () => envUtils.envStringToMap(appFilesManager.writeAppEnv.mock.lastCall?.[1] ?? '');

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [AppHelpers, { provide: EnvUtils, useValue: envUtils }],
    })
      .useMocker(mock)
      .compile();

    appHelpers = moduleRef.get(AppHelpers);
    appFilesManager = moduleRef.get(AppFilesManager);
    config = moduleRef.get(ConfigurationService);
  });

  describe('generateEnvFile', () => {
    const mockAppInfo: AppInfo = {
      id: 'test-app',
      urn: testAppUrn,
      name: 'Test App',
      author: 'Test Author',
      port: 8080,
      https: false,
      no_gui: false,
      available: true,
      exposable: true,
      dynamic_config: true,
      source: 'http://example.com',
      version: '1.0.0',
      categories: ['utilities'],
      description: 'Test description',
      short_desc: 'Test short description',
      website: 'http://example.com',
      supported_architectures: [],
      created_at: Date.now(),
      updated_at: Date.now(),
      deprecated: false,
      tipi_version: 1,
      force_expose: false,
      force_pull: false,
      generate_vapid_keys: false,
      form_fields: [],
    };

    beforeEach(() => {
      config.getConfig.mockReturnValue(
        fromPartial({
          internalIp: '127.0.0.1',
          rootFolderHost: '/opt/runtipi',
          userSettings: {
            appDataPath: '/opt/runtipi',
            localDomain: 'local.test',
            timeZone: 'Etc/UTC',
          },
        }),
      );

      appFilesManager.getInstalledAppInfo.mockResolvedValue(mockAppInfo);
      appFilesManager.getAppEnv.mockResolvedValue({ path: testAppEnv, content: '' });
      appFilesManager.writeAppEnv.mockResolvedValue(true);
    });

    it('should throw an error if app is not found', async () => {
      // Arrange
      appFilesManager.getInstalledAppInfo.mockResolvedValue(null);

      // Act & Assert
      await expect(appHelpers.generateEnvFile(testAppUrn, {})).rejects.toThrow(`App ${testAppUrn} not found`);
    });

    it('should set default env variables correctly', async () => {
      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(writtenEnv().get('APP_PORT')).toBe('8080');
      expect(writtenEnv().get('APP_ID')).toBe('test-app-test-store');
      expect(writtenEnv().get('ROOT_FOLDER_HOST')).toBe('/opt/runtipi');
      expect(writtenEnv().get('APP_DATA_DIR')).toBe('/opt/runtipi/app-data/test-store/test-app');
    });

    it('keeps public interpolation values and app-owned fields while discarding legacy Core variables', async () => {
      const forbidden = () => {
        throw new Error('Core environment data accessed while generating an app file');
      };
      Object.defineProperties(
        config.getConfig(),
        Object.fromEntries(['envFilePath', 'jwtSecret', 'database', 'queue'].map((key) => [key, { get: forbidden }])),
      );
      const legacyValue = 'synthetic-legacy-core-value';
      appFilesManager.getAppEnv.mockResolvedValue({
        path: testAppEnv,
        content: [
          `JWT_SECRET=${legacyValue}`,
          `POSTGRES_PASSWORD=${legacyValue}`,
          `RABBITMQ_PASSWORD=${legacyValue}`,
          `UNRELATED_SETTING=${legacyValue}`,
          'APP_RANDOM=kept-app-random',
        ].join('\n'),
      });
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        form_fields: [
          { env_variable: 'POSTGRES_PASSWORD', label: 'App database password', type: 'text', required: true },
          { env_variable: 'APP_RANDOM', label: 'App token', type: 'random', required: false },
        ],
      });

      await appHelpers.generateEnvFile(testAppUrn, { POSTGRES_PASSWORD: 'app-owned-fixture-value', exposedLocal: true });

      const env = writtenEnv();
      expect(env.get('LOCAL_DOMAIN')).toBe('local.test');
      expect(env.get('TZ')).toBe('Etc/UTC');
      expect(env.get('INTERNAL_IP')).toBe('127.0.0.1');
      expect(env.get('APP_LOCAL_DOMAIN')).toBe('test-app-test-store.local.test');
      expect(env.get('POSTGRES_PASSWORD')).toBe('app-owned-fixture-value');
      expect(env.get('APP_RANDOM')).toBe('kept-app-random');
      expect(['JWT_SECRET', 'RABBITMQ_PASSWORD', 'UNRELATED_SETTING'].some((key) => env.has(key))).toBe(false);
      expect([...env.values()].includes(legacyValue)).toBe(false);
      expect(appFilesManager.getUserEnv).not.toHaveBeenCalled();
    });

    it('does not launch an app when writing the isolated environment fails', async () => {
      const filesystem = mock<FilesystemService>();
      const logger = mock<LoggerService>();
      const dockerService = mock<DockerService>();
      config.getConfig.mockReturnValue({
        ...config.getConfig(),
        directories: { appDataDir: '/app-data', appDir: '/app', dataDir: '/data' },
      });
      const files = new AppFilesManager(config, filesystem, logger);
      vi.spyOn(files, 'getInstalledAppInfo').mockResolvedValue(mockAppInfo);
      vi.spyOn(files, 'getAppEnv').mockResolvedValue({ path: testAppEnv, content: 'LEGACY_ENV=synthetic-already-present' });
      filesystem.writePrivateTextFile.mockResolvedValue(false);
      const helpers = new AppHelpers(files, config, envUtils);
      const providers = new Map<unknown, unknown>([
        [AppFilesManager, files],
        [AppHelpers, helpers],
        [DockerService, dockerService],
        [LoggerService, logger],
      ]);
      const moduleRef = mock<ModuleRef>();
      moduleRef.get.mockImplementation((token) => providers.get(token) as never);
      class StartWithPreparedCompose extends StartAppCommand {
        protected override async ensureAppDir() {
          return undefined;
        }
      }

      const start = new StartWithPreparedCompose(moduleRef, fromPartial({}));
      await expect(start.execute(testAppUrn, {})).resolves.toEqual({
        success: false,
        message: `Failed to write app environment for ${testAppUrn}`,
      });
      expect(filesystem.writePrivateTextFile).toHaveBeenCalledOnce();
      expect(filesystem.writePrivateTextFile.mock.lastCall?.[0]).toBe(testAppEnv);
      expect(dockerService.composeApp).not.toHaveBeenCalled();
    });

    it('should handle form port override', async () => {
      // Arrange
      const customPort = 9090;

      // Act
      await appHelpers.generateEnvFile(testAppUrn, { port: customPort });

      // Assert
      expect(writtenEnv().get('APP_PORT')).toBe(String(customPort));
    });

    it('should generate VAPID keys if configured', async () => {
      // Arrange
      const appInfoWithVapid = { ...mockAppInfo, generate_vapid_keys: true };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithVapid);

      const mockVapidKeys = {
        publicKey: 'test-public-key',
        privateKey: 'test-private-key',
      };
      vi.spyOn(envUtils, 'generateVapidKeys').mockReturnValue(mockVapidKeys);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(writtenEnv().get('VAPID_PUBLIC_KEY')).toBe(mockVapidKeys.publicKey);
      expect(writtenEnv().get('VAPID_PRIVATE_KEY')).toBe(mockVapidKeys.privateKey);
    });

    it('should reuse existing VAPID keys if available', async () => {
      // Arrange
      appFilesManager.getAppEnv.mockResolvedValue({
        path: testAppEnv,
        content: 'VAPID_PUBLIC_KEY=existing-public-key\nVAPID_PRIVATE_KEY=existing-private-key',
      });

      const appInfoWithVapid = { ...mockAppInfo, generate_vapid_keys: true };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithVapid);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(writtenEnv().get('VAPID_PUBLIC_KEY')).toBe('existing-public-key');
      expect(writtenEnv().get('VAPID_PRIVATE_KEY')).toBe('existing-private-key');
    });

    it('should set correct domain settings when app is exposed', async () => {
      // Arrange
      const domain = 'test.example.com';

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {
        exposed: true,
        domain,
      });

      // Assert
      expect(writtenEnv().get('APP_EXPOSED')).toBe('true');
      expect(writtenEnv().get('APP_DOMAIN')).toBe(domain);
      expect(writtenEnv().get('APP_HOST')).toBe(domain);
      expect(writtenEnv().get('APP_PROTOCOL')).toBe('https');
    });

    it('should set correct domain settings for local exposure', async () => {
      // Act
      await appHelpers.generateEnvFile(testAppUrn, {
        exposedLocal: true,
        openPort: false,
      });

      // Assert
      expect(writtenEnv().get('APP_DOMAIN')).toBe('test-app-test-store.local.test');
      expect(writtenEnv().get('APP_HOST')).toBe('test-app-test-store.local.test');
      expect(writtenEnv().get('APP_PROTOCOL')).toBe('https');
    });

    it('should set correct domain settings for internal access', async () => {
      // Arrange
      const port = 8080;

      // Act
      await appHelpers.generateEnvFile(testAppUrn, { port });

      // Assert
      expect(writtenEnv().get('APP_DOMAIN')).toBe('127.0.0.1:8080');
      expect(writtenEnv().get('APP_HOST')).toBe('127.0.0.1');
      expect(writtenEnv().get('APP_PROTOCOL')).toBe('http');
    });

    it('should throw error for required form fields', async () => {
      // Arrange
      const appInfoWithRequired = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'REQUIRED_VAR',
            label: 'Required Variable',
            required: true,
            type: 'text' as const,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithRequired);

      // Act & Assert
      await expect(appHelpers.generateEnvFile(testAppUrn, {})).rejects.toThrow('Variable Required Variable is required');
    });

    it('should handle random type form fields', async () => {
      // Arrange
      const appInfoWithRandom = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'RANDOM_VAR',
            type: 'random' as const,
            min: 16,
            label: 'Random Variable',
            required: false,
            options: undefined,
            tooltip: undefined,
            force_write: undefined,
            value: undefined,
            placeholder: undefined,
            encoding: undefined,
            max: undefined,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithRandom);

      const randomString = 'random-string';
      const generate = vi.spyOn(envUtils, 'createRandomString').mockReturnValue(randomString);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(writtenEnv().get('RANDOM_VAR')).toBe(randomString);
      expect(generate).toHaveBeenCalledWith('RANDOM_VAR', 16, undefined);
    });

    it('should write the transformed env map to file', async () => {
      // Arrange
      appFilesManager.getInstalledAppInfo.mockResolvedValue({
        ...mockAppInfo,
        form_fields: [{ env_variable: 'TEST_VAR', label: 'Test field', type: 'text', required: false }],
      });

      // Act
      await appHelpers.generateEnvFile(testAppUrn, { TEST_VAR: 'test=value' });

      // Assert
      expect(appFilesManager.writeAppEnv).toHaveBeenCalledOnce();
      expect(writtenEnv().get('TEST_VAR')).toBe('test=value');
    });

    it('should use default value when form field is not provided', async () => {
      // Arrange
      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-text-value',
            required: false,
          },
          {
            env_variable: 'NUMBER_WITH_DEFAULT',
            label: 'Number Field',
            type: 'number' as const,
            default: 42,
            required: false,
          },
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act
      await appHelpers.generateEnvFile(testAppUrn, {});

      // Assert
      expect(writtenEnv().get('TEXT_WITH_DEFAULT')).toBe('default-text-value');
      expect(writtenEnv().get('NUMBER_WITH_DEFAULT')).toBe('42');
      expect(writtenEnv().get('BOOLEAN_WITH_DEFAULT')).toBe('true');
    });

    it('should use default value when form field is empty string', async () => {
      // Arrange
      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-value',
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing empty string from form
      await appHelpers.generateEnvFile(testAppUrn, { TEXT_WITH_DEFAULT: '' });

      // Assert - should use default value, not empty string
      expect(writtenEnv().get('TEXT_WITH_DEFAULT')).toBe('default-value');
    });

    it('should override default value when form provides a value', async () => {
      // Arrange
      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'TEXT_WITH_DEFAULT',
            label: 'Text Field',
            type: 'text' as const,
            default: 'default-value',
            required: false,
          },
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing custom values from form
      await appHelpers.generateEnvFile(testAppUrn, {
        TEXT_WITH_DEFAULT: 'custom-value',
        BOOLEAN_WITH_DEFAULT: false,
      });

      // Assert - should use form values, not defaults
      expect(writtenEnv().get('TEXT_WITH_DEFAULT')).toBe('custom-value');
      expect(writtenEnv().get('BOOLEAN_WITH_DEFAULT')).toBe('false');
    });

    it('should handle number zero as valid form value and not use default', async () => {
      // Arrange
      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'NUMBER_WITH_DEFAULT',
            label: 'Number Field',
            type: 'number' as const,
            default: 100,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing 0 as the value (which is falsy)
      await appHelpers.generateEnvFile(testAppUrn, { NUMBER_WITH_DEFAULT: 0 });

      // Assert - should use 0, not the default
      expect(writtenEnv().get('NUMBER_WITH_DEFAULT')).toBe('0');
    });

    it('should handle false as valid form value and not use default', async () => {
      // Arrange
      const appInfoWithDefaults = {
        ...mockAppInfo,
        form_fields: [
          {
            env_variable: 'BOOLEAN_WITH_DEFAULT',
            label: 'Boolean Field',
            type: 'boolean' as const,
            default: true,
            required: false,
          },
        ],
      };
      appFilesManager.getInstalledAppInfo.mockResolvedValue(appInfoWithDefaults);

      // Act - passing false as the value
      await appHelpers.generateEnvFile(testAppUrn, { BOOLEAN_WITH_DEFAULT: false });

      // Assert - should use false, not the default
      expect(writtenEnv().get('BOOLEAN_WITH_DEFAULT')).toBe('false');
    });
  });
});

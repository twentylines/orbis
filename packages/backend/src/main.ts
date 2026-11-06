import './common/controller-overlay-startup';
import './instrument';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { type INestApplication, type LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { AppService } from './app.service';
import { APP_DIR, DATA_DIR } from './common/constants';
import { coreCaptureRecoveryRequired } from './common/backup-maintenance';
import { inspectCoreCaptureSourceHold } from './modules/system-backups/time-machine-core-source-hold';
import { continueCoreCaptureAfterListen } from './modules/system-backups/time-machine-core-bootstrap';
import { generateSystemEnvFile } from './common/helpers/env-helpers';
import { captureInstallationMode, installationMode } from './common/installation-mode';
import { BackupRestoreJournal } from './modules/system-backups/backup-restore-journal';
import { BackupRestoresService } from './modules/system-backups/backup-restores.service';
import { SystemBackupsService } from './modules/system-backups/system-backups.service';
import { SettingsBackupApplyService } from './modules/system-backups/settings-backup-apply.service';
import { prepareSettingsRestoreEnvironment } from './modules/system-backups/settings-restore-startup';
import {
  captureRestoreStartupRole,
  retainedBootstrapStartup,
  retainedSettledStartup,
  waitForRestoreStartup,
} from './modules/system-backups/backup-restore-startup';
import { BackupRestoreActivationService } from './modules/system-backups/backup-restore-activation.service';
import {
  VerifierStartupDiagnostics,
  VerifierStartupFailure,
  reportVerifierStartupFailure,
} from './modules/system-backups/backup-restore-diagnostics';

const verifierDiagnostics = new VerifierStartupDiagnostics();

async function setupSwagger(app: INestApplication) {
  if (process.env.NODE_ENV === 'production') {
    return;
  }

  const { DocumentBuilder, SwaggerModule } = await import('@nestjs/swagger');
  const config = new DocumentBuilder()
    .setTitle('Runtipi API')
    .setDescription('API specs for Runtipi')
    .setVersion('1.0')
    .setOpenAPIVersion('3.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_: string, methodKey: string) => methodKey,
  });
  SwaggerModule.setup('api/docs', app, document);

  // write the swagger.json file to the assets folder
  await fs.promises.writeFile(path.join(APP_DIR, 'packages', 'backend', 'src', 'swagger.json'), JSON.stringify(document, null, 2));
}

async function bootstrap() {
  const captureHold = await inspectCoreCaptureSourceHold(DATA_DIR);
  if (captureHold === 'invalid') console.warn('Core capture source hold requires review.');
  const installation = installationMode();
  // Recovery must be decided before seed, settings or connection files can be generated.
  const restoreMode = coreCaptureRecoveryRequired()
    ? 'ordinary'
    : await waitForRestoreStartup({
        dataDirectory: DATA_DIR,
        controller: os.hostname(),
        installation,
        onHeld: () => console.warn('Waiting for full restore recovery before starting Orbis.'),
      });
  captureRestoreStartupRole(restoreMode);
  if (restoreMode === 'verify' && installation.phase === 'hold') verifierDiagnostics.enable();
  if (restoreMode === 'candidate' && installation.phase === 'normal') {
    const restore =
      (await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'))) ??
      (await BackupRestoreJournal.latest(path.join(DATA_DIR, 'backups', 'restores')));
    if (!restore || restore.state.decision !== 'commit' || !restore.state.candidateController.startsWith(os.hostname()))
      throw new Error('Restore startup ownership changed.');
    captureInstallationMode({ ORBIS_INSTALLER_TRANSACTION: restore.state.id, ORBIS_INSTALLER_PHASE: 'resume' });
  } else captureInstallationMode();
  if (coreCaptureRecoveryRequired()) await generateSystemEnvFile({ readOnly: true });
  else
    await prepareSettingsRestoreEnvironment(DATA_DIR, () =>
      verifierDiagnostics.run('env', () =>
        generateSystemEnvFile({ readOnly: restoreMode === 'verify' || retainedBootstrapStartup() || retainedSettledStartup() }),
      ),
    );

  const app = await verifierDiagnostics.run('app', () =>
    NestFactory.create<NestExpressApplication>(AppModule, {
      abortOnError: !verifierDiagnostics.active,
      logger: [process.env.LOG_LEVEL as LogLevel, 'error', 'warn', 'fatal'],
    }),
  );
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  const appService = app.get(AppService);
  await verifierDiagnostics.run('database', () =>
    appService.bootstrap(() =>
      verifierDiagnostics.run('recovery', async () => {
        await app.get(SettingsBackupApplyService).prepareStartup();
        await app.get(SystemBackupsService).onModuleInit();
        await app.get(BackupRestoresService).prepareStartup();
      }),
    ),
  );
  const activation = app.get(BackupRestoreActivationService);
  activation.configureRetainedContinuation({
    prepare: () => appService.prepareRetainedNormalContinuation(),
    activate: () => appService.activateRetainedNormalContinuation(),
  });
  if (!coreCaptureRecoveryRequired()) await verifierDiagnostics.run('activation', () => activation.resumeApps());

  app.set('trust proxy', true);
  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors();
  app.use(cookieParser());

  await setupSwagger(app);

  await verifierDiagnostics.run('listen', () => app.listen(3000));
  if (captureHold === 'held') {
    const captureStartup = new AbortController();
    const cancelCaptureStartup = () => captureStartup.abort();
    process.once('SIGTERM', cancelCaptureStartup);
    process.once('SIGINT', cancelCaptureStartup);
    try {
      await continueCoreCaptureAfterListen(app, DATA_DIR, captureStartup.signal);
    } catch {
      console.warn('Snapshot recovery needs attention. Orbis remains held.');
    } finally {
      process.removeListener('SIGTERM', cancelCaptureStartup);
      process.removeListener('SIGINT', cancelCaptureStartup);
    }
  }
}

bootstrap().catch((err) => {
  if (verifierDiagnostics.active) {
    reportVerifierStartupFailure(
      err instanceof VerifierStartupFailure ? err : new VerifierStartupFailure('startup', undefined),
      (marker, finished) => process.stderr.write(marker, finished),
      () => process.exit(1),
    );
    return;
  }
  console.error(err);
  process.exit(1);
});

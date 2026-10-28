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
import { generateSystemEnvFile } from './common/helpers/env-helpers';
import { captureInstallationMode, installationMode } from './common/installation-mode';
import { BackupRestoreJournal } from './modules/system-backups/backup-restore-journal';
import { BackupRestoresService } from './modules/system-backups/backup-restores.service';
import { SystemBackupsService } from './modules/system-backups/system-backups.service';
import { captureRestoreStartupRole, waitForRestoreStartup } from './modules/system-backups/backup-restore-startup';
import { BackupRestoreActivationService } from './modules/system-backups/backup-restore-activation.service';

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
  const installation = installationMode();
  // Recovery must be decided before seed, settings or connection files can be generated.
  const restoreMode = await waitForRestoreStartup({
    dataDirectory: DATA_DIR,
    controller: os.hostname(),
    installation,
    onHeld: () => console.warn('Waiting for full restore recovery before starting Orbis.'),
  });
  captureRestoreStartupRole(restoreMode);
  if (restoreMode === 'candidate' && installation.phase === 'normal') {
    const restore = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
    if (!restore || restore.state.decision !== 'commit' || !restore.state.candidateController.startsWith(os.hostname()))
      throw new Error('Restore startup ownership changed.');
    captureInstallationMode({ ORBIS_INSTALLER_TRANSACTION: restore.state.id, ORBIS_INSTALLER_PHASE: 'resume' });
  } else captureInstallationMode();
  await generateSystemEnvFile({ readOnly: restoreMode === 'verify' });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: true,
    logger: [process.env.LOG_LEVEL as LogLevel, 'error', 'warn', 'fatal'],
  });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);

  const appService = app.get(AppService);
  await appService.bootstrap(async () => {
    await app.get(SystemBackupsService).onModuleInit();
    await app.get(BackupRestoresService).prepareStartup();
  });
  await app.get(BackupRestoreActivationService).resumeApps();

  app.set('trust proxy', true);
  app.setGlobalPrefix('/api');
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors();
  app.use(cookieParser());

  await setupSwagger(app);

  await app.listen(3000);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

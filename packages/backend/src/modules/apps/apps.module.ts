import { ConfigurationModule } from '@/core/config/configuration.module';
import { Module } from '@nestjs/common';
import { EnvModule } from '../env/env.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { QueueModule } from '../queue/queue.module';
import { AppFilesManager } from './app-files-manager';
import { AppHelpers } from './app.helpers';
import { AppEmbeddingController } from './app-embedding.controller';
import { AppEmbeddingService } from './app-embedding.service';
import { AppsController } from './apps.controller';
import { AppsRepository } from './apps.repository';
import { AppsService } from './apps.service';

@Module({
  imports: [QueueModule, ConfigurationModule, EnvModule, MarketplaceModule],
  controllers: [AppsController, AppEmbeddingController],
  providers: [AppFilesManager, AppsRepository, AppHelpers, AppsService, AppEmbeddingService],
  exports: [AppsRepository, AppFilesManager, AppHelpers, AppsService],
})
export class AppsModule {}

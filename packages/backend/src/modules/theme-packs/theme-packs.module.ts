import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { ThemePacksController } from './theme-packs.controller';
import { ThemePacksService } from './theme-packs.service';

@Module({ imports: [ConfigurationModule], controllers: [ThemePacksController], providers: [ThemePacksService] })
export class ThemePacksModule {}

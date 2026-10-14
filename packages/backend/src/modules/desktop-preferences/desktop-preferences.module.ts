import { ConfigurationModule } from '@/core/config/configuration.module';
import { Module } from '@nestjs/common';
import { DesktopPreferencesController } from './desktop-preferences.controller';
import { DesktopPreferencesService } from './desktop-preferences.service';

@Module({ imports: [ConfigurationModule], controllers: [DesktopPreferencesController], providers: [DesktopPreferencesService] })
export class DesktopPreferencesModule {}

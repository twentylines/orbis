import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { ThemePacksController } from './theme-packs.controller';
import { ThemePacksService } from './theme-packs.service';
import { DesktopPreferencesModule } from '../desktop-preferences/desktop-preferences.module';
import { ThemeSettingsController } from '../theme-settings/theme-settings.controller';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';

@Module({
  imports: [ConfigurationModule, DesktopPreferencesModule],
  controllers: [ThemePacksController, ThemeSettingsController],
  providers: [ThemePacksService, ThemeSettingsService],
})
export class ThemePacksModule {}

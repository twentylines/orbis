import { Module } from '@nestjs/common';
import { MonitoringActivityService } from './monitoring-activity.service';
import { BrowserPresenceController } from './browser-presence.controller';

@Module({ controllers: [BrowserPresenceController], providers: [MonitoringActivityService], exports: [MonitoringActivityService] })
export class MonitoringActivityModule {}

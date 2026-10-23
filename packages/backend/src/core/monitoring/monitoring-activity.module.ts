import { Module } from '@nestjs/common';
import { MonitoringActivityService } from './monitoring-activity.service';

@Module({ providers: [MonitoringActivityService], exports: [MonitoringActivityService] })
export class MonitoringActivityModule {}

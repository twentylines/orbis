import { Module } from '@nestjs/common';
import { HostUpdatesController } from './host-updates.controller';
import { HostUpdatesGuard } from './host-updates.guard';
import { HostUpdatesService } from './host-updates.service';

@Module({ controllers: [HostUpdatesController], providers: [HostUpdatesService, HostUpdatesGuard] })
export class HostUpdatesModule {}

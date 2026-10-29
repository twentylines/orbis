import { Module } from '@nestjs/common';
import { HostUpdatesGuard } from '../host-updates/host-updates.guard';
import { TransferTransport } from '../host-transfer/transfer-transport';
import { NearbyDiscoveryController } from './discovery.controller';
import { NearbyDiscoveryService } from './discovery.service';

@Module({ controllers: [NearbyDiscoveryController], providers: [NearbyDiscoveryService, HostUpdatesGuard, TransferTransport] })
export class NearbyDiscoveryModule {}

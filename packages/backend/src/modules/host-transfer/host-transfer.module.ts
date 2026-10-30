import { ReceiverRequestController, ReceiverRequestPeerController } from './receiver-request.controller';
import { ReceiverRequestService } from './receiver-request.service';
import { TransferCapacity } from './transfer-capacity';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemBackupsModule } from '../system-backups/system-backups.module';
import { HostTransferController } from './host-transfer.controller';
import { HostTransferService } from './host-transfer.service';
import { TransferTransport } from './transfer-transport';
import { TransferIngress } from './transfer-ingress';
import { DockerModule } from '../docker/docker.module';

@Module({
  imports: [AuthModule, SystemBackupsModule, DockerModule],
  controllers: [HostTransferController, ReceiverRequestController, ReceiverRequestPeerController],
  providers: [HostTransferService, TransferTransport, TransferIngress, TransferCapacity, ReceiverRequestService],
})
export class HostTransferModule {}

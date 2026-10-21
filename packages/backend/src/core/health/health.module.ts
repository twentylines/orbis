import { QueueModule } from '@/modules/queue/queue.module';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { InstallationController } from './installation.controller';

@Module({
  controllers: [HealthController, InstallationController],
  imports: [TerminusModule, QueueModule],
  providers: [],
})
export class HealthModule {}

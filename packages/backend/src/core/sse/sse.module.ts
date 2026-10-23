import { DockerModule } from '@/modules/docker/docker.module';
import { DesktopPreferencesModule } from '@/modules/desktop-preferences/desktop-preferences.module';
import { Module } from '@nestjs/common';
import { SSEController } from './sse.controller';
import { SSEService } from './sse.service';

@Module({
  imports: [DockerModule, DesktopPreferencesModule],
  controllers: [SSEController],
  providers: [SSEService],
  exports: [SSEService],
})
export class SSEModule {}

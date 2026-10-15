import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';
import { OrbisReleaseService } from './orbis-release.service';

@Module({
  imports: [],
  controllers: [SystemController],
  providers: [SystemService, OrbisReleaseService],
  exports: [],
})
export class SystemModule {}

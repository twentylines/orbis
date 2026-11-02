import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SystemBackupsModule } from '../system-backups/system-backups.module';
import { CapsulesService } from './capsules.service';
import { CapsulesController } from './capsules.controller';
@Module({ imports: [AuthModule, SystemBackupsModule], providers: [CapsulesService], controllers: [CapsulesController] })
export class CapsulesModule {}

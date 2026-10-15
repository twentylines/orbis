import { Module } from '@nestjs/common';
import { ConfigurationModule } from '@/core/config/configuration.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({ imports: [ConfigurationModule], controllers: [TasksController], providers: [TasksService], exports: [TasksService] })
export class TasksModule {}

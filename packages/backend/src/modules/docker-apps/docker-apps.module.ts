import { Module } from '@nestjs/common';
import { AppsModule } from '../apps/apps.module';
import { DockerModule } from '../docker/docker.module';
import { TasksModule } from '../tasks/tasks.module';
import { DockerAppsController } from './docker-apps.controller';
import { DockerAppsService } from './docker-apps.service';

@Module({ imports: [AppsModule, DockerModule, TasksModule], controllers: [DockerAppsController], providers: [DockerAppsService] })
export class DockerAppsModule {}

import { ConfigurationService } from '@/core/config/configuration.service';
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppEventsQueue, appEventSchema } from './entities/app-events';
import { RepoEventsQueue, repoCommandSchema } from './entities/repo-events';
import { SystemEventsQueue, systemCommandSchema } from './entities/system-events';
import { QueueFactory } from './queue.factory';
import { QueueHealthIndicator } from './queue.health';
import { TasksModule } from '../tasks/tasks.module';
import { TasksService } from '../tasks/tasks.service';

@Module({
  imports: [TerminusModule, TasksModule],
  providers: [
    QueueHealthIndicator,
    QueueFactory,
    {
      provide: AppEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService, tasks: TasksService) => {
        const timeout = config.get('userSettings').eventsTimeout * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: 'app-events-queue',
          workers: 3,
          eventSchema: appEventSchema,
          timeout: timeout,
          observer: { queued: (event) => tasks.enqueue(event), unconfirmed: (event) => tasks.unconfirmed(event) },
        });
      },
      inject: [QueueFactory, ConfigurationService, TasksService],
    },
    {
      provide: RepoEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService) => {
        const timeout = config.get('userSettings').eventsTimeout * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: 'repo-queue',
          workers: 3,
          eventSchema: repoCommandSchema,
          timeout: timeout,
        });
      },
      inject: [QueueFactory, ConfigurationService],
    },
    {
      provide: SystemEventsQueue,
      useFactory: async (queueFactory: QueueFactory, config: ConfigurationService) => {
        const timeout = config.get('userSettings').eventsTimeout * 60 * 1000;

        return await queueFactory.createQueue({
          queueName: 'system-events-queue',
          workers: 1,
          eventSchema: systemCommandSchema,
          timeout: timeout,
        });
      },
      inject: [QueueFactory, ConfigurationService],
    },
  ],
  exports: [AppEventsQueue, RepoEventsQueue, SystemEventsQueue, QueueHealthIndicator],
})
export class QueueModule {}

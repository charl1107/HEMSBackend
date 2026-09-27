import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { EventsController } from './events.controller.js';
import { PublicEventsController } from './public-events.controller.js';
import { EventsService } from './events.service.js';
import { COVER_STORAGE, createCoverStorage } from './cover-file.js';

@Module({
  imports: [ApprovalsModule],
  controllers: [EventsController, PublicEventsController],
  providers: [
    EventsService,
    {
      provide: COVER_STORAGE,
      useFactory: () => createCoverStorage(),
    },
  ],
  exports: [EventsService, COVER_STORAGE],
})
export class EventsModule {}

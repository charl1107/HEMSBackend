import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { EventsService } from './events.service.js';
import { EventListQueryDto } from './dto/event.dto.js';
import { SchedulingService } from '../scheduling/scheduling.service.js';

@Public()
@Controller('public/events')
export class PublicEventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly schedulingService: SchedulingService,
  ) {}

  @Get()
  findAll(@Query() query: EventListQueryDto) {
    return this.eventsService.findPublicMany(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.eventsService.findPublicOne(id);
  }

  @Get(':id/schedule')
  findSchedule(@Param('id') id: string) {
    return this.schedulingService.findPublicSchedule(id);
  }
}

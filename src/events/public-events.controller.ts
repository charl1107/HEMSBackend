import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator.js';
import { EventsService } from './events.service.js';
import type { EventListQueryDto } from './dto/event.dto.js';

@Public()
@Controller('public/events')
export class PublicEventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  findAll(@Query() query: EventListQueryDto) {
    return this.eventsService.findPublicMany(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.eventsService.findPublicOne(id);
  }
}

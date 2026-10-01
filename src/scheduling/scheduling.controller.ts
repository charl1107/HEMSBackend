import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user.js';
import { SchedulingService } from './scheduling.service.js';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events/:eventId/schedule')
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Get()
  findAll(@Param('eventId') eventId: string) {
    return this.schedulingService.findMany(eventId);
  }

  // F6: same dynamic planning-access rule as tasks (owner ∪ committee member
  // ∪ Admin/Department Head) — no static @Roles; denial tests pin the check.
  @Post()
  create(
    @Param('eventId') eventId: string,
    @Body() dto: CreateScheduleDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.schedulingService.create(eventId, req.user, dto);
  }

  @Patch(':id')
  update(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() dto: UpdateScheduleDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.schedulingService.update(eventId, id, req.user, dto);
  }

  @Delete(':id')
  remove(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.schedulingService.remove(eventId, id, req.user);
  }
}

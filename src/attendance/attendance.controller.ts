import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../common/decorators/roles.decorator.js';
import { ATTENDANCE_SUPERVISOR_ROLES } from '../events/events.constants.js';
import type { AuthUser } from '../common/auth-user.js';
import { AttendanceService } from './attendance.service.js';
import { SyncAttendanceDto, TimeAttendanceDto } from './dto/attendance.dto.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events/:eventId/attendance')
export class EventAttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get()
  @Roles(...ATTENDANCE_SUPERVISOR_ROLES)
  findMany(@Param('eventId') eventId: string) {
    return this.attendanceService.findMany(eventId);
  }

  @Post('time-in')
  @Roles(...ATTENDANCE_SUPERVISOR_ROLES)
  timeIn(
    @Param('eventId') eventId: string,
    @Body() dto: TimeAttendanceDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.attendanceService.timeIn(eventId, req.user, dto);
  }

  @Post('time-out')
  @Roles(...ATTENDANCE_SUPERVISOR_ROLES)
  timeOut(
    @Param('eventId') eventId: string,
    @Body() dto: TimeAttendanceDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.attendanceService.timeOut(eventId, req.user, dto);
  }
}

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get('me')
  findMine(@Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.attendanceService.findMine(req.user);
  }

  @Post('sync')
  @Roles(...ATTENDANCE_SUPERVISOR_ROLES)
  sync(@Body() dto: SyncAttendanceDto, @Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.attendanceService.sync(req.user, dto);
  }
}

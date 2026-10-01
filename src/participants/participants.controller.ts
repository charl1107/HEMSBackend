import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import {
  ROSTER_MANAGER_ROLES,
  STUDENT_SELF_REGISTER_ROLES,
} from '../events/events.constants.js';
import { ParticipantsService } from './participants.service.js';
import { AddParticipantDto } from './dto/participant.dto.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events/:eventId/participants')
export class ParticipantsController {
  constructor(private readonly participantsService: ParticipantsService) {}

  @Get()
  @Roles(...ROSTER_MANAGER_ROLES)
  findAll(@Param('eventId') eventId: string) {
    return this.participantsService.findMany(eventId);
  }

  // F6: the only participants write whose legitimate set is static — the
  // roster writes below stay service-checked because a static @Roles would
  // either block an event owner or be vacuous.
  @Post('register')
  @Roles(...STUDENT_SELF_REGISTER_ROLES)
  selfRegister(
    @Param('eventId') eventId: string,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.participantsService.selfRegister(eventId, req.user);
  }

  // F6: owner ∪ ROSTER_MANAGER_ROLES is dynamic — no static @Roles here;
  // the service check is pinned by the cross-role denial tests instead.
  @Post()
  add(
    @Param('eventId') eventId: string,
    @Body() dto: AddParticipantDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.participantsService.add(eventId, req.user, dto);
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
    return this.participantsService.remove(eventId, id, req.user);
  }
}

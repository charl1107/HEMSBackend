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
import { ROSTER_MANAGER_ROLES } from '../events/events.constants.js';
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

  @Post('register')
  selfRegister(
    @Param('eventId') eventId: string,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.participantsService.selfRegister(eventId, req.user);
  }

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

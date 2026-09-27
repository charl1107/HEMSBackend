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
import { CommitteesService } from './committees.service.js';
import { AddCommitteeMemberDto, CreateCommitteeDto } from './dto/committee.dto.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events/:eventId/committees')
export class CommitteesController {
  constructor(private readonly committeesService: CommitteesService) {}

  @Get()
  findAll(@Param('eventId') eventId: string) {
    return this.committeesService.findMany(eventId);
  }

  @Post()
  create(
    @Param('eventId') eventId: string,
    @Body() dto: CreateCommitteeDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.committeesService.create(eventId, req.user, dto);
  }

  @Post(':id/members')
  addMember(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() dto: AddCommitteeMemberDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.committeesService.addMember(eventId, id, req.user, dto);
  }

  @Delete(':id/members/:userId')
  removeMember(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.committeesService.removeMember(eventId, id, userId, req.user);
  }
}

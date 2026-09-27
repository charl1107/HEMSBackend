import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user.js';
import { NotificationsService } from './notifications.service.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMany(@Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.notificationsService.findMany(req.user.userId);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: RequestWithUser) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.notificationsService.markRead(req.user.userId, id);
  }
}

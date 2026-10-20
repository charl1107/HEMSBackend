import { Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user.js';
import { NotificationsService } from './notifications.service.js';

// The global JwtAuthGuard (app.module APP_GUARD) runs before any handler on
// this non-@Public controller, so req.user is always set here (401 otherwise).
type RequestWithUser = Request & { user: AuthUser };

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMany(@Req() req: RequestWithUser) {
    return this.notificationsService.findMany(req.user.userId);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.notificationsService.markRead(req.user.userId, id);
  }
}

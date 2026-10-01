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
import { TasksService } from './tasks.service.js';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto.js';

type RequestWithUser = Request & { user?: AuthUser };

@Controller('events/:eventId/tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  findAll(@Param('eventId') eventId: string) {
    return this.tasksService.findMany(eventId);
  }

  // F6: `assertCanManagePlanning` (owner ∪ committee member ∪ Admin/DeptHead)
  // is dynamic — committee membership is resolved per request, so a static
  // @Roles would be vacuous. Pinned by the denial tests instead.
  @Post()
  create(
    @Param('eventId') eventId: string,
    @Body() dto: CreateTaskDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.tasksService.create(eventId, req.user, dto);
  }

  @Patch(':id')
  update(
    @Param('eventId') eventId: string,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
    @Req() req: RequestWithUser,
  ) {
    if (!req.user) {
      throw new ForbiddenException('Authentication required');
    }
    return this.tasksService.update(eventId, id, req.user, dto);
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
    return this.tasksService.remove(eventId, id, req.user);
  }
}

import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EventTask, Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  assertCanManagePlanning,
  assertPlanningStatusGate,
  findPlanningEvent,
} from '../common/planning-access.js';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto.js';

const TASK_INCLUDE = {
  assignedToUser: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} as const;

export type EventTaskWithAssignee = EventTask & {
  assignedToUser: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'> | null;
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async findMany(eventId: string): Promise<EventTaskWithAssignee[]> {
    await findPlanningEvent(this.prisma, eventId);
    return this.prisma.eventTask.findMany({
      where: { eventId },
      include: TASK_INCLUDE,
      orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(
    eventId: string,
    auth: AuthUser,
    dto: CreateTaskDto,
  ): Promise<EventTaskWithAssignee> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    if (dto.assignedToUserId) {
      await this.assertUserExists(dto.assignedToUserId);
    }
    const task = await this.prisma.eventTask.create({
      data: {
        eventId,
        title: dto.title,
        description: dto.description?.trim() || null,
        assignedToUserId: dto.assignedToUserId ?? null,
        deadline: new Date(dto.deadline),
        status: 'Todo',
      },
      include: TASK_INCLUDE,
    });
    if (task.assignedToUserId) {
      await this.notifications.notify({
        actorId: auth.userId,
        userIds: [task.assignedToUserId],
        type: 'TaskAssigned',
        message: `You have been assigned task "${task.title}"`,
        eventId,
      });
    }
    return task;
  }

  async update(
    eventId: string,
    id: string,
    auth: AuthUser,
    dto: UpdateTaskDto,
  ): Promise<EventTaskWithAssignee> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    const previous = await this.findTask(eventId, id);
    if (dto.assignedToUserId) {
      await this.assertUserExists(dto.assignedToUserId);
    }
    const data: Prisma.EventTaskUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) {
      data.description = dto.description.trim() || null;
    }
    if (dto.deadline !== undefined) data.deadline = new Date(dto.deadline);
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.assignedToUserId !== undefined) {
      data.assignedToUser = dto.assignedToUserId
        ? { connect: { id: dto.assignedToUserId } }
        : { disconnect: true };
    }
    const task = await this.prisma.eventTask.update({
      where: { id },
      data,
      include: TASK_INCLUDE,
    });
    if (
      dto.assignedToUserId &&
      dto.assignedToUserId !== previous.assignedToUserId
    ) {
      await this.notifications.notify({
        actorId: auth.userId,
        userIds: [dto.assignedToUserId],
        type: 'TaskAssigned',
        message: `You have been assigned task "${dto.title ?? previous.title}"`,
        eventId,
      });
    }
    return task;
  }

  async remove(eventId: string, id: string, auth: AuthUser): Promise<void> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    await this.findTask(eventId, id);
    await this.prisma.eventTask.delete({ where: { id } });
  }

  private async findTask(
    eventId: string,
    id: string,
  ): Promise<EventTask> {
    const task = await this.prisma.eventTask.findFirst({
      where: { id, eventId },
    });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('Assignee user not found');
    }
  }
}

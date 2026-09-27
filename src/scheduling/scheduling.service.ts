import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { EventSchedule, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  assertCanManagePlanning,
  assertPlanningStatusGate,
  findPlanningEvent,
} from '../common/planning-access.js';
import { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto.js';

@Injectable()
export class SchedulingService {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(eventId: string): Promise<EventSchedule[]> {
    await findPlanningEvent(this.prisma, eventId);
    return this.prisma.eventSchedule.findMany({
      where: { eventId },
      orderBy: { startTime: 'asc' },
    });
  }

  async create(
    eventId: string,
    auth: AuthUser,
    dto: CreateScheduleDto,
  ): Promise<EventSchedule> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);
    this.assertTimeOrder(startTime, endTime);
    return this.prisma.eventSchedule.create({
      data: {
        eventId,
        activityName: dto.activityName,
        startTime,
        endTime,
      },
    });
  }

  async update(
    eventId: string,
    id: string,
    auth: AuthUser,
    dto: UpdateScheduleDto,
  ): Promise<EventSchedule> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    const schedule = await this.findSchedule(eventId, id);
    const startTime =
      dto.startTime !== undefined ? new Date(dto.startTime) : schedule.startTime;
    const endTime =
      dto.endTime !== undefined ? new Date(dto.endTime) : schedule.endTime;
    this.assertTimeOrder(startTime, endTime);
    const data: Prisma.EventScheduleUpdateInput = {};
    if (dto.activityName !== undefined) data.activityName = dto.activityName;
    if (dto.startTime !== undefined) data.startTime = startTime;
    if (dto.endTime !== undefined) data.endTime = endTime;
    return this.prisma.eventSchedule.update({ where: { id }, data });
  }

  async remove(eventId: string, id: string, auth: AuthUser): Promise<void> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await assertCanManagePlanning(this.prisma, event, auth);
    await this.findSchedule(eventId, id);
    await this.prisma.eventSchedule.delete({ where: { id } });
  }

  private assertTimeOrder(startTime: Date, endTime: Date): void {
    if (!(endTime.getTime() > startTime.getTime())) {
      throw new BadRequestException('endTime must be after startTime');
    }
  }

  private async findSchedule(
    eventId: string,
    id: string,
  ): Promise<EventSchedule> {
    const schedule = await this.prisma.eventSchedule.findFirst({
      where: { id, eventId },
    });
    if (!schedule) {
      throw new NotFoundException('Schedule entry not found');
    }
    return schedule;
  }
}

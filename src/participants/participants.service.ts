import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Event, Participant, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  ROSTER_EVENT_STATUSES,
  ROSTER_MANAGER_ROLES,
  STUDENT_SELF_REGISTER_ROLES,
} from '../events/events.constants.js';
import { AddParticipantDto } from './dto/participant.dto.js';

const PARTICIPANT_INCLUDE = {
  user: { select: { id: true, firstName: true, lastName: true, email: true } },
} as const;

export type ParticipantWithUser = Participant & {
  user: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'> | null;
};

@Injectable()
export class ParticipantsService {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(eventId: string): Promise<ParticipantWithUser[]> {
    await this.findEvent(eventId);
    return this.prisma.participant.findMany({
      where: { eventId },
      include: PARTICIPANT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async selfRegister(eventId: string, auth: AuthUser): Promise<ParticipantWithUser> {
    const event = await this.findEvent(eventId);
    this.assertStatusGate(event);
    this.assertStudentRole(auth);
    await this.assertNoDuplicateUser(eventId, auth.userId);
    return this.prisma.participant.create({
      data: {
        eventId,
        userId: auth.userId,
        externalName: null,
        participantType: 'Student',
        registrationStatus: 'Registered',
      },
      include: PARTICIPANT_INCLUDE,
    });
  }

  async add(
    eventId: string,
    auth: AuthUser,
    dto: AddParticipantDto,
  ): Promise<ParticipantWithUser> {
    const event = await this.findEvent(eventId);
    this.assertStatusGate(event);
    this.assertCanManageRoster(event, auth);
    const externalName = dto.externalName?.trim();
    const userId = dto.userId?.trim();

    if (userId && externalName) {
      throw new BadRequestException(
        'Provide exactly one of userId or externalName',
      );
    }

    if (externalName) {
      await this.assertNoDuplicateExternalName(eventId, externalName);
      return this.prisma.participant.create({
        data: {
          eventId,
          userId: null,
          externalName,
          participantType: 'Guest',
          registrationStatus: 'Registered',
        },
        include: PARTICIPANT_INCLUDE,
      });
    }

    if (!userId) {
      throw new BadRequestException(
        'Provide exactly one of userId or externalName',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.assertNoDuplicateUser(eventId, userId);
    return this.prisma.participant.create({
      data: {
        eventId,
        userId,
        externalName: null,
        participantType: dto.participantType ?? 'Student',
        registrationStatus: 'Registered',
      },
      include: PARTICIPANT_INCLUDE,
    });
  }

  async remove(eventId: string, id: string, auth: AuthUser): Promise<void> {
    const event = await this.findEvent(eventId);
    this.assertStatusGate(event);
    this.assertCanManageRoster(event, auth);
    const participant = await this.prisma.participant.findFirst({
      where: { id, eventId },
    });
    if (!participant) {
      throw new NotFoundException('Participant not found');
    }
    await this.prisma.participant.delete({ where: { id } });
  }

  private async findEvent(id: string): Promise<Event> {
    const event = await this.prisma.event.findUnique({
      where: { id },
      select: { id: true, status: true, createdById: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event as Event;
  }

  private assertStatusGate(event: Pick<Event, 'status'>): void {
    if (!(ROSTER_EVENT_STATUSES as readonly string[]).includes(event.status)) {
      throw new ConflictException(
        `Participant operations require event status Approved, Planning, Ongoing, or Completed (current: ${event.status})`,
      );
    }
  }

  private assertStudentRole(auth: AuthUser): void {
    if (!STUDENT_SELF_REGISTER_ROLES.some((role) => auth.roles.includes(role))) {
      throw new ForbiddenException(
        'Only students can self-register as participants',
      );
    }
  }

  private assertCanManageRoster(event: Pick<Event, 'createdById'>, auth: AuthUser): void {
    const isOwner = event.createdById === auth.userId;
    const hasRole = ROSTER_MANAGER_ROLES.some((role) => auth.roles.includes(role));
    if (!isOwner && !hasRole) {
      throw new ForbiddenException(
        'Only the event owner or a roster-role user can manage participants',
      );
    }
  }

  private async assertNoDuplicateUser(eventId: string, userId: string): Promise<void> {
    const existing = await this.prisma.participant.findFirst({
      where: { eventId, userId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('User is already a participant of this event');
    }
  }

  private async assertNoDuplicateExternalName(
    eventId: string,
    externalName: string,
  ): Promise<void> {
    const existing = await this.prisma.participant.findFirst({
      where: {
        eventId,
        externalName: { equals: externalName, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'An external participant with this name already exists for this event',
      );
    }
  }
}

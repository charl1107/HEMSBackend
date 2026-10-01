import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Committee, CommitteeMember, Event, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  COMMITTEE_MANAGER_ROLES,
  ROSTER_EVENT_STATUSES,
} from '../events/events.constants.js';
import { AddCommitteeMemberDto, CreateCommitteeDto } from './dto/committee.dto.js';

const COMMITTEE_INCLUDE = {
  members: {
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

const MEMBER_USER_SELECT = {
  select: { id: true, firstName: true, lastName: true, email: true },
} as const;

export type CommitteeWithMembers = Committee & {
  members: (CommitteeMember & {
    user: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'>;
  })[];
};

@Injectable()
export class CommitteesService {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(eventId: string): Promise<CommitteeWithMembers[]> {
    await this.findEvent(eventId);
    return this.prisma.committee.findMany({
      where: { eventId },
      include: COMMITTEE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(
    eventId: string,
    auth: AuthUser,
    dto: CreateCommitteeDto,
  ): Promise<CommitteeWithMembers> {
    const event = await this.findEvent(eventId);
    this.assertCanManageCommittees(event, auth);
    this.assertStatusGate(event);
    const name = dto.name.trim();
    const existing = await this.prisma.committee.findFirst({
      where: { eventId, name: { equals: name, mode: 'insensitive' } },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'A committee with this name already exists for this event',
      );
    }
    return this.prisma.committee.create({
      data: {
        eventId,
        name,
        description: dto.description?.trim() || null,
      },
      include: COMMITTEE_INCLUDE,
    });
  }

  async addMember(
    eventId: string,
    committeeId: string,
    auth: AuthUser,
    dto: AddCommitteeMemberDto,
  ): Promise<CommitteeWithMembers> {
    const event = await this.findEvent(eventId);
    this.assertCanManageCommittees(event, auth);
    this.assertStatusGate(event);
    const committee = await this.findCommittee(eventId, committeeId);
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: MEMBER_USER_SELECT.select,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    const existing = await this.prisma.committeeMember.findUnique({
      where: { committeeId_userId: { committeeId, userId: dto.userId } },
    });
    if (existing) {
      throw new ConflictException('User is already a member of this committee');
    }
    await this.prisma.committeeMember.create({
      data: { committeeId: committee.id, userId: dto.userId },
    });
    return this.prisma.committee.findUniqueOrThrow({
      where: { id: committee.id },
      include: COMMITTEE_INCLUDE,
    });
  }

  async removeMember(
    eventId: string,
    committeeId: string,
    userId: string,
    auth: AuthUser,
  ): Promise<void> {
    const event = await this.findEvent(eventId);
    this.assertCanManageCommittees(event, auth);
    this.assertStatusGate(event);
    await this.findCommittee(eventId, committeeId);
    const member = await this.prisma.committeeMember.findUnique({
      where: { committeeId_userId: { committeeId, userId } },
    });
    if (!member) {
      throw new NotFoundException('Committee member not found');
    }
    await this.prisma.committeeMember.delete({
      where: { committeeId_userId: { committeeId, userId } },
    });
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

  private async findCommittee(
    eventId: string,
    committeeId: string,
  ): Promise<Committee> {
    const committee = await this.prisma.committee.findFirst({
      where: { id: committeeId, eventId },
    });
    if (!committee) {
      throw new NotFoundException('Committee not found');
    }
    return committee;
  }

  private assertStatusGate(event: Pick<Event, 'status'>): void {
    if (!(ROSTER_EVENT_STATUSES as readonly string[]).includes(event.status)) {
      throw new ConflictException(
        `Committee operations require event status Approved, Planning, Ongoing, or Completed (current: ${event.status})`,
      );
    }
  }

  private assertCanManageCommittees(
    event: Pick<Event, 'createdById'>,
    auth: AuthUser,
  ): void {
    const isOwner = event.createdById === auth.userId;
    const hasManagerRole = COMMITTEE_MANAGER_ROLES.some((role) =>
      auth.roles.includes(role),
    );
    if (!isOwner && !hasManagerRole) {
      throw new ForbiddenException(
        'Only the event owner, Admin, or Department Head can manage committees',
      );
    }
  }
}

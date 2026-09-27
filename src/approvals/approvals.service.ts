import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  Approval,
  Event,
  EventType,
  EventStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Page, PageQueryDto } from '../common/dto/page-query.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { canTransition } from '../events/event-state.js';
import {
  conflictMessage,
  conflictSelect,
  conflictWhere,
  type ConflictHit,
} from '../events/conflict.js';
import { SUBMIT_EVENT_ROLES } from '../events/events.constants.js';
import {
  ApproveEventDto,
  RejectEventDto,
  RequestRevisionDto,
  SubmitForApprovalDto,
} from './dto/approval.dto.js';

const EVENT_WITH_TYPE = { eventType: true } as const;

const DEPARTMENT_HEAD_ROLE = 'Department Head';

type EventWithMeta = Event & { eventType: EventType | null };
type Tx = Pick<PrismaService, 'event' | 'approval' | 'auditLog'>;

export interface ApproveResult extends EventWithMeta {
  conflictWarning: string | null;
}

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async submit(
    id: string,
    user: AuthUser,
    dto: SubmitForApprovalDto = {},
  ): Promise<EventWithMeta> {
    const event = await this.findEvent(id);
    this.assertCanSubmit(event, user);
    this.assertTransition(event.status, 'PendingApproval');
    const updated = await this.prisma.$transaction(async (tx) => {
      const done = await this.transition(
        tx,
        id,
        event.status,
        'PendingApproval',
      );
      await tx.approval.create({
        data: {
          eventId: id,
          reviewerId: user.userId,
          action: 'Submitted',
          comments: dto.comments ?? null,
        },
      });
      return done;
    });
    await this.notifications.notifyRole(DEPARTMENT_HEAD_ROLE, {
      actorId: user.userId,
      type: 'EventSubmitted',
      message: `Event "${event.title}" has been submitted for approval`,
      eventId: id,
    });
    return updated;
  }

  async approve(
    id: string,
    user: AuthUser,
    dto: ApproveEventDto = {},
  ): Promise<ApproveResult> {
    const event = await this.findEvent(id);
    this.assertTransition(event.status, 'Approved');
    const conflict = await this.findConflict(event);
    if (conflict && !dto.overrideConflict) {
      throw new ConflictException({
        message: conflictMessage(conflict),
        conflict,
        requiresOverride: true,
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.transition(tx, id, event.status, 'Approved');
      await tx.approval.create({
        data: {
          eventId: id,
          reviewerId: user.userId,
          action: 'Approved',
          comments: dto.comments ?? null,
        },
      });
      const planned = await this.transition(tx, id, 'Approved', 'Planning');
      if (conflict) {
        await this.audit.logWith(tx, {
          userId: user.userId,
          method: 'POST',
          path: `/events/${id}/approve`,
          body: {
            action: 'approve',
            eventId: id,
            overrideConflict: true,
            conflict,
          },
          statusCode: 200,
        });
      }
      return planned;
    });
    await this.notifications.notify({
      actorId: user.userId,
      userIds: event.createdById ? [event.createdById] : [],
      type: 'EventApproved',
      message: `Event "${event.title}" has been approved`,
      eventId: id,
    });
    return {
      ...updated,
      conflictWarning: conflict ? conflictMessage(conflict) : null,
    };
  }

  async reject(
    id: string,
    user: AuthUser,
    dto: RejectEventDto,
  ): Promise<EventWithMeta> {
    if (!dto.reason?.trim()) {
      throw new BadRequestException('reason is required');
    }
    const event = await this.findEvent(id);
    this.assertTransition(event.status, 'Rejected');
    const updated = await this.prisma.$transaction(async (tx) => {
      const done = await this.transition(tx, id, event.status, 'Rejected');
      await tx.approval.create({
        data: {
          eventId: id,
          reviewerId: user.userId,
          action: 'Rejected',
          comments: dto.reason,
        },
      });
      return done;
    });
    await this.notifications.notify({
      actorId: user.userId,
      userIds: event.createdById ? [event.createdById] : [],
      type: 'EventRejected',
      message: `Event "${event.title}" has been rejected`,
      eventId: id,
    });
    return updated;
  }

  async requestRevision(
    id: string,
    user: AuthUser,
    dto: RequestRevisionDto,
  ): Promise<EventWithMeta> {
    if (!dto.comments?.trim()) {
      throw new BadRequestException('comments is required');
    }
    const event = await this.findEvent(id);
    this.assertTransition(event.status, 'RevisionRequired');
    const updated = await this.prisma.$transaction(async (tx) => {
      const done = await this.transition(
        tx,
        id,
        event.status,
        'RevisionRequired',
      );
      await tx.approval.create({
        data: {
          eventId: id,
          reviewerId: user.userId,
          action: 'RevisionRequested',
          comments: dto.comments,
        },
      });
      return done;
    });
    await this.notifications.notify({
      actorId: user.userId,
      userIds: event.createdById ? [event.createdById] : [],
      type: 'RevisionRequested',
      message: `Revision requested for event "${event.title}"`,
      eventId: id,
    });
    return updated;
  }

  async findApprovalHistory(
    eventId: string,
  ): Promise<
    (Approval & {
      reviewer: {
        id: string;
        firstName: string;
        lastName: string;
      } | null;
    })[]
  > {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return this.prisma.approval.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' },
      include: {
        reviewer: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async findPage(
    query?: PageQueryDto,
  ): Promise<
    Page<
      Event & {
        eventType: EventType | null;
        approvals: Approval[];
      }
    >
  > {
    const where: Prisma.EventWhereInput = { status: 'PendingApproval' };
    const take = query?.limit ?? 100;
    const skip = query?.offset ?? 0;
    const [items, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        include: {
          ...EVENT_WITH_TYPE,
          approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: [{ eventDate: 'asc' }, { createdAt: 'asc' }],
        take,
        skip,
      }),
      this.prisma.event.count({ where }),
    ]);
    return { items, total };
  }

  private async findEvent(id: string): Promise<Event> {
    const event = await this.prisma.event.findUnique({ where: { id } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async findConflict(event: Event): Promise<ConflictHit | null> {
    return this.prisma.event.findFirst({
      where: conflictWhere(event.venue, event.eventDate, event.id),
      select: conflictSelect(),
    });
  }

  private assertCanSubmit(event: Event, user: AuthUser): void {
    const isOwner = event.createdById === user.userId;
    const hasSubmitRole = SUBMIT_EVENT_ROLES.some((role) =>
      user.roles.includes(role),
    );
    if (!isOwner && !hasSubmitRole) {
      throw new ForbiddenException(
        'Only the event owner or a submit-role user can submit',
      );
    }
  }

  private assertTransition(from: EventStatus, to: EventStatus): void {
    if (!canTransition(from, to)) {
      throw new ConflictException(
        `Invalid event status transition ${from} → ${to}`,
      );
    }
  }

  private async transition(
    tx: Tx,
    id: string,
    from: EventStatus,
    to: EventStatus,
  ): Promise<EventWithMeta> {
    this.assertTransition(from, to);
    const { count } = await tx.event.updateMany({
      where: { id, status: from },
      data: { status: to },
    });
    if (count === 0) {
      throw new ConflictException('event status changed');
    }
    const updated = await tx.event.findUnique({
      where: { id },
      include: EVENT_WITH_TYPE,
    });
    if (!updated) {
      throw new ConflictException('event status changed');
    }
    return updated;
  }
}

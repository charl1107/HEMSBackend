import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Event, EventType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateEventDto, UpdateEventDto } from './dto/event.dto.js';
import type { EventListQueryDto } from './dto/event.dto.js';
import type { Page } from '../common/dto/page-query.dto.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  EDITABLE_EVENT_STATUSES,
  PUBLIC_EVENT_STATUSES,
  REVIEW_EVENT_ROLES,
  SUBMIT_EVENT_ROLES,
} from './events.constants.js';
import { canTransition } from './event-state.js';
import {
  conflictMessage,
  conflictSelect,
  conflictWhere,
  type ConflictHit,
} from './conflict.js';
import {
  assertCoverFile,
  COVER_STORAGE,
  coverExtension,
  createCoverStorage,
  type CoverStorage,
  type CoverUploadFile,
} from './cover-file.js';

export type { ConflictHit } from './conflict.js';
export const EVENT_INCLUDE = { eventType: true } as const;

/**
 * The anonymous public catalog and detail pages (F18) render exactly the
 * fields below — derived from `PublicEventListView.vue` (id, title, venue,
 * description, status, eventDate, coverImageUrl) and `PublicEventDetailView.vue`
 * (+ eventType.name) — so the two public methods ask Prisma for this subset
 * instead of the full row. `createdById`, `eventTypeId`, `updatedAt` and the
 * rest are internal and must never leave the server unauthenticated.
 * Authenticated paths keep `EVENT_INCLUDE` and their full-row shape.
 */
export const PUBLIC_EVENT_SELECT = {
  id: true,
  title: true,
  description: true,
  eventDate: true,
  venue: true,
  coverImageUrl: true,
  status: true,
  eventType: { select: { name: true } },
} as const satisfies Prisma.EventSelect;

/** A public catalog/detail event exactly as `PUBLIC_EVENT_SELECT` shapes it. */
export type PublicEvent = Pick<
  Event,
  'id' | 'title' | 'description' | 'eventDate' | 'venue' | 'coverImageUrl' | 'status'
> & { eventType: { name: string } | null };

/**
 * Roles that may drive POST /events/:id/advance on events they do not own.
 * Event Coordinators are deliberately excluded: in the four-status rework
 * they are plain owners of their own events and lost cross-event power.
 */
const ADVANCE_EVENT_ROLES = ['Admin', 'Department Head'] as const;

export type EventWithRelations = Event & { eventType: EventType | null };

export interface EventResult extends EventWithRelations {
  conflictWarning: string | null;
}

@Injectable()
export class EventsService {
  private readonly coverStorage: CoverStorage;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(COVER_STORAGE) coverStorage?: CoverStorage,
  ) {
    this.coverStorage = coverStorage ?? createCoverStorage();
  }

  static canTransition(
    from: Event['status'],
    to: Event['status'],
  ): boolean {
    return canTransition(from, to);
  }

  private static listWhere(query?: EventListQueryDto): Prisma.EventWhereInput {
    const where: Prisma.EventWhereInput = {};
    if (query?.status?.length) where.status = { in: [...query.status] };
    if (query?.campusScope) where.campusScope = query.campusScope;
    if (query?.type) where.eventType = { name: query.type };
    return where;
  }

  private static isReviewer(user: AuthUser): boolean {
    return REVIEW_EVENT_ROLES.some((role) => user.roles.includes(role));
  }

  private static canViewEvent(
    user: AuthUser | undefined,
    event: Pick<Event, 'status' | 'createdById'>,
  ): boolean {
    if (!user) {
      return false;
    }
    if (EventsService.isReviewer(user)) {
      return true;
    }
    if (event.createdById && event.createdById === user.userId) {
      return true;
    }
    if (
      event.status === 'PendingApproval' &&
      SUBMIT_EVENT_ROLES.some((role) => user.roles.includes(role))
    ) {
      return true;
    }
    return (PUBLIC_EVENT_STATUSES as readonly string[]).includes(event.status);
  }

  private static visibilityFilter(user: AuthUser): Prisma.EventWhereInput {
    if (EventsService.isReviewer(user)) {
      return {};
    }
    const allowed: Event['status'][] = [...PUBLIC_EVENT_STATUSES];
    if (SUBMIT_EVENT_ROLES.some((role) => user.roles.includes(role))) {
      allowed.push('PendingApproval');
    }
    const filters: Prisma.EventWhereInput[] = [{ status: { in: allowed } }];
    if (user.userId) {
      filters.push({ createdById: user.userId });
    }
    return { OR: filters };
  }

  async findPage(
    query: EventListQueryDto | undefined,
    user: AuthUser,
  ): Promise<Page<EventWithRelations>> {
    const filters = EventsService.listWhere(query);
    const visibility = EventsService.visibilityFilter(user);
    const where =
      Object.keys(visibility).length === 0
        ? filters
        : Object.keys(filters).length === 0
          ? visibility
          : { AND: [filters, visibility] };
    const take = query?.limit ?? 100;
    const skip = query?.offset ?? 0;
    const [items, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        include: EVENT_INCLUDE,
        orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
      }),
      this.prisma.event.count({ where }),
    ]);
    return { items, total };
  }

  async findOne(id: string): Promise<EventWithRelations> {
    const event = await this.prisma.event.findUnique({
      where: { id },
      include: EVENT_INCLUDE,
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  async findOneVisible(
    id: string,
    user: AuthUser,
  ): Promise<EventWithRelations> {
    const event = await this.findOne(id);
    if (!EventsService.canViewEvent(user, event)) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  async create(dto: CreateEventDto, userId?: string): Promise<EventResult> {
    const venue = dto.venue.trim();
    const eventDate = new Date(dto.eventDate);
    if (dto.eventTypeId) {
      await this.assertEventTypeExists(dto.eventTypeId);
    }
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        eventDate,
        venue,
        department: dto.department?.trim() || null,
        campusScope: dto.campusScope ?? 'OnCampus',
        status: 'Planning',
        eventTypeId: dto.eventTypeId ?? null,
        createdById: userId ?? null,
      },
      include: EVENT_INCLUDE,
    });
    const conflictWarning = await this.buildConflictWarning(
      venue,
      eventDate,
      event.id,
    );
    return { ...event, conflictWarning };
  }

  async update(
    id: string,
    dto: UpdateEventDto,
    user?: AuthUser,
  ): Promise<EventResult> {
    const event = await this.findOne(id);
    this.assertCanEdit(event, user);
    this.assertEditable(event);
    const venue = dto.venue !== undefined ? dto.venue.trim() : event.venue;
    const department =
      dto.department !== undefined
        ? dto.department.trim() || null
        : event.department;
    const eventDate =
      dto.eventDate !== undefined ? new Date(dto.eventDate) : event.eventDate;
    if (dto.eventTypeId) {
      await this.assertEventTypeExists(dto.eventTypeId);
    }
    const data: Prisma.EventUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.eventDate !== undefined) data.eventDate = eventDate;
    if (dto.venue !== undefined) data.venue = venue;
    if (dto.department !== undefined) data.department = department;
    if (dto.campusScope !== undefined) data.campusScope = dto.campusScope;
    if (dto.eventTypeId !== undefined) {
      data.eventType = dto.eventTypeId
        ? { connect: { id: dto.eventTypeId } }
        : { disconnect: true };
    }
    const updated = await this.prisma.event.update({
      where: { id },
      data,
      include: EVENT_INCLUDE,
    });
    const conflictWarning = await this.buildConflictWarning(
      venue,
      eventDate,
      id,
    );
    return { ...updated, conflictWarning };
  }

  async remove(id: string, user?: AuthUser): Promise<void> {
    const event = await this.findOne(id);
    this.assertCanEdit(event, user);
    this.assertEditable(event);
    if (event.coverImageUrl) {
      await this.deleteCoverFile(event.coverImageUrl);
    }
    await this.prisma.event.delete({ where: { id } });
  }

  /**
   * POST /events/:id/advance — drives an event along EVENT_TRANSITIONS:
   * Planning → Ongoing → Completed, plus cancel (any live status →
   * Cancelled) and resume (Cancelled → Planning). Authorization: owner,
   * Admin or Department Head — not Event Coordinator. The write is guarded
   * with the optimistic-concurrency where-clause from approvals.service.ts
   * `transition()`: it names the status read from the row, so a concurrent
   * change between read and write matches no row and yields 409.
   */
  async advance(
    id: string,
    to: Event['status'],
    user: AuthUser,
  ): Promise<EventWithRelations> {
    const event = await this.findOne(id);
    this.assertCanAdvance(event, user);
    if (!canTransition(event.status, to)) {
      throw new ConflictException(
        `Invalid event status transition ${event.status} → ${to}`,
      );
    }
    const { count } = await this.prisma.event.updateMany({
      where: { id, status: event.status },
      data: { status: to },
    });
    if (count === 0) {
      throw new ConflictException('event status changed');
    }
    return this.findOne(id);
  }

  async setCover(
    id: string,
    file: CoverUploadFile | undefined,
    user?: AuthUser,
  ): Promise<EventWithRelations> {
    const event = await this.findOne(id);
    this.assertCanEdit(event, user);
    this.assertEditable(event);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Cover image file is required');
    }
    const mime = assertCoverFile(file);
    const filename = `${randomUUID()}.${coverExtension(mime)}`;
    const storageKey = `covers/${id}/${filename}`;
    const coverImageUrl = await this.coverStorage.put(
      storageKey,
      file.buffer,
      mime,
    );
    const updated = await this.prisma.event.update({
      where: { id },
      data: { coverImageUrl },
      include: EVENT_INCLUDE,
    });
    if (event.coverImageUrl && event.coverImageUrl !== coverImageUrl) {
      await this.deleteCoverFile(event.coverImageUrl);
    }
    return updated;
  }

  async removeCover(id: string, user?: AuthUser): Promise<EventWithRelations> {
    const event = await this.findOne(id);
    this.assertCanEdit(event, user);
    this.assertEditable(event);
    if (event.coverImageUrl) {
      await this.deleteCoverFile(event.coverImageUrl);
    }
    return this.prisma.event.update({
      where: { id },
      data: { coverImageUrl: null },
      include: EVENT_INCLUDE,
    });
  }

  async findPublicMany(query?: EventListQueryDto): Promise<Page<PublicEvent>> {
    const baseWhere: Prisma.EventWhereInput = {
      status: { in: [...PUBLIC_EVENT_STATUSES] },
    };
    const eventWhere = EventsService.listWhere(query);
    const where: Prisma.EventWhereInput =
      Object.keys(eventWhere).length === 0
        ? baseWhere
        : { AND: [baseWhere, eventWhere] };
    const take = query?.limit ?? 100;
    const skip = query?.offset ?? 0;
    const [items, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        select: PUBLIC_EVENT_SELECT,
        orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
        take,
        skip,
      }),
      this.prisma.event.count({ where }),
    ]);
    return { items, total };
  }

  async findPublicOne(id: string): Promise<PublicEvent> {
    const event = await this.prisma.event.findFirst({
      where: { id, status: { in: [...PUBLIC_EVENT_STATUSES] } },
      select: PUBLIC_EVENT_SELECT,
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  async findConflict(
    venue: string,
    eventDate: Date,
    excludeId?: string,
  ): Promise<ConflictHit | null> {
    return this.prisma.event.findFirst({
      where: conflictWhere(venue, eventDate, excludeId),
      select: conflictSelect(),
    });
  }

  private async buildConflictWarning(
    venue: string,
    eventDate: Date,
    excludeId: string | undefined,
  ): Promise<string | null> {
    const conflict = await this.findConflict(venue, eventDate, excludeId);
    if (!conflict) {
      return null;
    }
    return conflictMessage(conflict);
  }

  private assertCanEdit(event: EventWithRelations, user?: AuthUser): void {
    const isOwner = Boolean(user && event.createdById === user.userId);
    const isReviewer = Boolean(
      user && REVIEW_EVENT_ROLES.some((role) => user.roles.includes(role)),
    );
    if (!isOwner && !isReviewer) {
      throw new ForbiddenException(
        'Only a review-role user or the event owner can edit this event',
      );
    }
  }

  private assertCanAdvance(event: EventWithRelations, user: AuthUser): void {
    const isOwner = event.createdById === user.userId;
    const isPrivileged = ADVANCE_EVENT_ROLES.some((role) =>
      user.roles.includes(role),
    );
    if (!isOwner && !isPrivileged) {
      throw new ForbiddenException(
        'Only the event owner, an Admin or a Department Head can change event status',
      );
    }
  }

  private assertEditable(event: EventWithRelations): void {
    if (
      !(EDITABLE_EVENT_STATUSES as readonly string[]).includes(event.status)
    ) {
      throw new ConflictException(
        `Event can only be edited while Planning or Ongoing (current: ${event.status})`,
      );
    }
  }

  private async assertEventTypeExists(eventTypeId: string): Promise<void> {
    const eventType = await this.prisma.eventType.findUnique({
      where: { id: eventTypeId },
    });
    if (!eventType) {
      throw new NotFoundException('Event type not found');
    }
  }

  private async deleteCoverFile(coverImageUrl: string): Promise<void> {
    try {
      await this.coverStorage.remove(coverImageUrl);
    } catch {
      // File already gone or unable to delete — nothing to clean up.
    }
  }
}

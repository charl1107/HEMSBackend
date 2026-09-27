import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Event } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth-user.js';
import {
  COMMITTEE_MANAGER_ROLES,
  CONFLICT_EXCLUDED_STATUSES,
} from '../events/events.constants.js';

export type PlanningEvent = Pick<Event, 'id' | 'status' | 'createdById'>;

export async function findPlanningEvent(
  prisma: PrismaService,
  eventId: string,
): Promise<PlanningEvent> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, status: true, createdById: true },
  });
  if (!event) {
    throw new NotFoundException('Event not found');
  }
  return event;
}

export function assertPlanningStatusGate(event: PlanningEvent): void {
  if ((CONFLICT_EXCLUDED_STATUSES as readonly string[]).includes(event.status)) {
    throw new ConflictException(
      `Task and schedule operations are not allowed when event status is ${event.status}`,
    );
  }
}

export async function canManagePlanning(
  prisma: PrismaService,
  event: PlanningEvent,
  auth: AuthUser,
): Promise<boolean> {
  if (event.createdById === auth.userId) {
    return true;
  }
  if (COMMITTEE_MANAGER_ROLES.some((role) => auth.roles.includes(role))) {
    return true;
  }
  const membership = await prisma.committeeMember.findFirst({
    where: { userId: auth.userId, committee: { eventId: event.id } },
    select: { id: true },
  });
  return Boolean(membership);
}

export async function assertCanManagePlanning(
  prisma: PrismaService,
  event: PlanningEvent,
  auth: AuthUser,
): Promise<void> {
  if (await canManagePlanning(prisma, event, auth)) {
    return;
  }
  throw new ForbiddenException(
    'Only the event owner, a committee member of this event, Admin, or Department Head can manage tasks and schedule',
  );
}

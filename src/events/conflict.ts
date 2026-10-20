import type { Prisma } from '@prisma/client';
import { CONFLICT_EXCLUDED_STATUSES } from './events.constants.js';

export interface ConflictHit {
  id: string;
  title: string;
  venue: string;
  eventDate: Date;
}

export function conflictWhere(
  venue: string,
  eventDate: Date,
  excludeId?: string,
): Prisma.EventWhereInput {
  return {
    venue: { equals: venue.trim(), mode: 'insensitive' },
    eventDate,
    status: { notIn: [...CONFLICT_EXCLUDED_STATUSES] },
    ...(excludeId ? { id: { not: excludeId } } : {}),
  };
}

export function conflictSelect() {
  return { id: true, title: true, venue: true, eventDate: true } as const;
}

export function conflictMessage(conflict: ConflictHit): string {
  return `Venue conflict: "${conflict.title}" already uses this venue on ${conflict.eventDate.toISOString().slice(0, 10)}`;
}

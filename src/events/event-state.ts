import type { EventStatus } from '@prisma/client';

export const EVENT_STATUSES = [
  'Planning',
  'Ongoing',
  'Completed',
  'Cancelled',
] as const satisfies readonly EventStatus[];

export const EVENT_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  Planning: ['Ongoing', 'Cancelled'],
  Ongoing: ['Completed', 'Cancelled'],
  Completed: [],
  Cancelled: ['Planning'],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  if (from === to) {
    return false;
  }
  return EVENT_TRANSITIONS[from].includes(to);
}

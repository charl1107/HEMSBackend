import type { EventStatus } from '@prisma/client';

export const EVENT_STATUSES = [
  'Draft',
  'PendingApproval',
  'RevisionRequired',
  'Approved',
  'Rejected',
  'Planning',
  'Ongoing',
  'Completed',
  'Cancelled',
] as const satisfies readonly EventStatus[];

export const EVENT_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  Draft: ['PendingApproval', 'Cancelled'],
  PendingApproval: ['Approved', 'Rejected', 'RevisionRequired', 'Cancelled'],
  RevisionRequired: ['PendingApproval', 'Cancelled'],
  Approved: ['Planning', 'Cancelled'],
  Planning: ['Ongoing', 'Cancelled'],
  Ongoing: ['Completed', 'Cancelled'],
  Completed: [],
  Rejected: [],
  Cancelled: [],
};

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  if (from === to) {
    return false;
  }
  return (EVENT_TRANSITIONS[from] ?? []).includes(to);
}

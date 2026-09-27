import { describe, expect, it } from 'vitest';
import type { EventStatus } from '@prisma/client';
import { canTransition, EVENT_STATUSES, EVENT_TRANSITIONS } from './event-state.js';

const ALL: EventStatus[] = [...EVENT_STATUSES];

const VALID: ReadonlyArray<readonly [EventStatus, EventStatus]> = [
  ['Draft', 'PendingApproval'],
  ['Draft', 'Cancelled'],
  ['PendingApproval', 'Approved'],
  ['PendingApproval', 'Rejected'],
  ['PendingApproval', 'RevisionRequired'],
  ['PendingApproval', 'Cancelled'],
  ['RevisionRequired', 'PendingApproval'],
  ['RevisionRequired', 'Cancelled'],
  ['Approved', 'Planning'],
  ['Approved', 'Cancelled'],
  ['Planning', 'Ongoing'],
  ['Planning', 'Cancelled'],
  ['Ongoing', 'Completed'],
  ['Ongoing', 'Cancelled'],
];

const validSet = new Set(VALID.map(([from, to]) => `${from}|${to}`));

const pairs: Array<[EventStatus, EventStatus, boolean]> = ALL.flatMap((from) =>
  ALL.map((to) => [from, to, validSet.has(`${from}|${to}`)] as const),
);

describe('canTransition (table-driven, all 9 statuses)', () => {
  it('covers every ordered status pair', () => {
    expect(pairs).toHaveLength(9 * 9);
  });

  it.each(pairs)('%s → %s allows=%s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  it('never allows self transitions', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('never allows skipping PendingApproval approval steps', () => {
    expect(canTransition('Draft', 'Approved')).toBe(false);
    expect(canTransition('Draft', 'Planning')).toBe(false);
    expect(canTransition('PendingApproval', 'Planning')).toBe(false);
    expect(canTransition('PendingApproval', 'Ongoing')).toBe(false);
    expect(canTransition('RevisionRequired', 'Approved')).toBe(false);
  });

  it('keeps terminal states terminal', () => {
    expect(EVENT_TRANSITIONS.Completed).toEqual([]);
    expect(EVENT_TRANSITIONS.Rejected).toEqual([]);
    expect(EVENT_TRANSITIONS.Cancelled).toEqual([]);
    for (const terminal of ['Completed', 'Rejected', 'Cancelled'] as const) {
      for (const to of ALL) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('allows Cancelled from non-terminal pre-completed states', () => {
    for (const from of [
      'Draft',
      'PendingApproval',
      'RevisionRequired',
      'Approved',
      'Planning',
      'Ongoing',
    ] as const) {
      expect(canTransition(from, 'Cancelled')).toBe(true);
    }
    expect(canTransition('Completed', 'Cancelled')).toBe(false);
    expect(canTransition('Rejected', 'Cancelled')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { EventStatus } from '@prisma/client';
import { canTransition, EVENT_STATUSES, EVENT_TRANSITIONS } from './event-state.js';

const ALL: EventStatus[] = [...EVENT_STATUSES];

const VALID: ReadonlyArray<readonly [EventStatus, EventStatus]> = [
  ['Planning', 'Ongoing'],
  ['Planning', 'Cancelled'],
  ['Ongoing', 'Completed'],
  ['Ongoing', 'Cancelled'],
  ['Cancelled', 'Planning'],
];

const validSet = new Set(VALID.map(([from, to]) => `${from}|${to}`));

const pairs: Array<[EventStatus, EventStatus, boolean]> = ALL.flatMap((from) =>
  ALL.map((to) => [from, to, validSet.has(`${from}|${to}`)] as const),
);

describe('canTransition (table-driven, all 4 statuses)', () => {
  it('EVENT_STATUSES lists exactly Planning, Ongoing, Completed, Cancelled', () => {
    expect([...EVENT_STATUSES]).toEqual([
      'Planning',
      'Ongoing',
      'Completed',
      'Cancelled',
    ]);
  });

  it('EVENT_TRANSITIONS maps exactly the four statuses', () => {
    expect(EVENT_TRANSITIONS).toEqual({
      Planning: ['Ongoing', 'Cancelled'],
      Ongoing: ['Completed', 'Cancelled'],
      Completed: [],
      Cancelled: ['Planning'],
    });
  });

  it('covers every ordered status pair', () => {
    expect(pairs).toHaveLength(4 * 4);
  });

  it.each(pairs)('%s → %s allows=%s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected);
  });

  it('never allows self transitions', () => {
    expect(canTransition('Planning', 'Planning')).toBe(false);
  });

  it('allows resuming a cancelled event', () => {
    expect(canTransition('Cancelled', 'Planning')).toBe(true);
  });

  it('keeps Completed terminal', () => {
    for (const to of ALL) {
      expect(canTransition('Completed', to)).toBe(false);
    }
  });
});

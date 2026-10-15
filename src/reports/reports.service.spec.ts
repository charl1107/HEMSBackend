import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import {
  ReportsService,
  isAbsentee,
  type EventReport,
} from './reports.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ABSENTEE_DEFINITION } from './reports.constants.js';

type MockPrisma = {
  event: {
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
  eventType: { findMany: ReturnType<typeof vi.fn> };
  participant: {
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  attendance: {
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  eventTask: { groupBy: ReturnType<typeof vi.fn> };
};

function makePrisma(): MockPrisma {
  return {
    event: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    eventType: { findMany: vi.fn().mockResolvedValue([]) },
    participant: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    attendance: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    eventTask: { groupBy: vi.fn().mockResolvedValue([]) },
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Spring Fair',
    description: 'Fun day',
    eventDate: new Date('2026-03-01T00:00:00.000Z'),
    venue: 'Main Hall',
    status: 'Completed' as EventStatus,
    eventTypeId: 'type-1',
    eventType: { name: 'Fair' },
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function participantRow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    eventId: 'evt-1',
    userId: null,
    externalName: `Guest ${id}`,
    participantType: 'Guest',
    registrationStatus: 'Registered',
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    user: null,
    attendance: [] as {
      status: 'Present' | 'Absent';
      timeIn: Date | null;
      timeOut: Date | null;
    }[],
    ...overrides,
  };
}

describe('isAbsentee', () => {
  it('treats explicit Absent as absentee regardless of event status', () => {
    expect(isAbsentee('Ongoing', 'Absent')).toBe(true);
    expect(isAbsentee('Completed', 'Absent')).toBe(true);
    expect(isAbsentee('Completed', 'Present')).toBe(false);
  });

  it('treats missing attendance as absentee only when event ended', () => {
    expect(isAbsentee('Completed', null)).toBe(true);
    expect(isAbsentee('Ongoing', null)).toBe(false);
    expect(isAbsentee('Cancelled', null)).toBe(false);
  });
});

describe('ReportsService', () => {
  let prisma: MockPrisma;
  let service: ReportsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ReportsService(prisma as unknown as PrismaService);
  });

  describe('getSummary aggregations', () => {
    it('computes event, participant, attendance, and task numbers', async () => {
      prisma.event.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);
      prisma.event.groupBy.mockResolvedValue([
        { status: 'Completed', _count: { _all: 2 } },
        { status: 'Planning', _count: { _all: 3 } },
      ]);
      prisma.eventType.findMany.mockResolvedValue([
        { id: 'type-1', name: 'Fair' },
        { id: 'type-2', name: 'Seminar' },
      ]);
      prisma.event.findMany.mockResolvedValue([
        {
          id: 'evt-1',
          title: 'Spring Fair',
          status: 'Completed',
          eventTypeId: 'type-1',
        },
        {
          id: 'evt-2',
          title: 'Talk',
          status: 'Planning',
          eventTypeId: 'type-2',
        },
        {
          id: 'evt-3',
          title: 'Meetup',
          status: 'Planning',
          eventTypeId: null,
        },
      ]);
      prisma.participant.groupBy
        .mockResolvedValueOnce([
          { participantType: 'Student', _count: { _all: 6 } },
          { participantType: 'Guest', _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([
          { eventId: 'evt-1', _count: { _all: 4 } },
          { eventId: 'evt-2', _count: { _all: 4 } },
        ]);
      prisma.attendance.groupBy
        .mockResolvedValueOnce([
          { status: 'Present', _count: { _all: 6 } },
          { status: 'Absent', _count: { _all: 2 } },
        ])
        .mockResolvedValueOnce([
          { eventId: 'evt-1', status: 'Present', _count: { _all: 3 } },
          { eventId: 'evt-1', status: 'Absent', _count: { _all: 1 } },
          { eventId: 'evt-2', status: 'Present', _count: { _all: 3 } },
          { eventId: 'evt-2', status: 'Absent', _count: { _all: 1 } },
        ]);
      prisma.eventTask.groupBy.mockResolvedValue([
        { status: 'Done', _count: { _all: 4 } },
        { status: 'Todo', _count: { _all: 6 } },
      ]);

      const summary = await service.getSummary();

      expect(summary.events).toEqual({
        total: 5,
        completed: 2,
        byStatus: [
          { status: 'Completed', count: 2 },
          { status: 'Planning', count: 3 },
        ],
        byType: [
          { type: 'Fair', count: 1 },
          { type: 'Seminar', count: 1 },
          { type: 'Uncategorized', count: 1 },
        ],
      });
      expect(summary.participants).toEqual({
        total: 8,
        byType: [
          { type: 'Guest', count: 2 },
          { type: 'Student', count: 6 },
        ],
      });
      expect(summary.attendance.present).toBe(6);
      expect(summary.attendance.absent).toBe(2);
      expect(summary.attendance.recorded).toBe(8);
      expect(summary.attendance.presentRate).toBe(0.75);
      expect(summary.attendance.absentRate).toBe(0.25);
      expect(summary.tasks).toEqual({
        total: 10,
        done: 4,
        completionRate: 0.4,
      });
      expect(summary.absenteeDefinition).toBe(ABSENTEE_DEFINITION);

      const evt1 = summary.attendance.byEvent.find(
        (row) => row.eventId === 'evt-1',
      );
      expect(evt1).toEqual({
        eventId: 'evt-1',
        title: 'Spring Fair',
        status: 'Completed',
        registered: 4,
        present: 3,
        absent: 1,
        missing: 0,
        presentRate: 0.75,
        absentRate: 0.25,
      });

      const evt2 = summary.attendance.byEvent.find(
        (row) => row.eventId === 'evt-2',
      );
      expect(evt2).toEqual({
        eventId: 'evt-2',
        title: 'Talk',
        status: 'Planning',
        registered: 4,
        present: 3,
        absent: 1,
        missing: 0,
        presentRate: 0.75,
        absentRate: 0.25,
      });
    });

    it('counts missing attendance as absentees for completed events in byEvent', async () => {
      prisma.event.count.mockResolvedValue(1).mockResolvedValue(1);
      prisma.event.groupBy.mockResolvedValue([
        { status: 'Completed', _count: { _all: 1 } },
      ]);
      prisma.event.findMany.mockResolvedValue([
        {
          id: 'evt-1',
          title: 'Done Event',
          status: 'Completed',
          eventTypeId: null,
        },
      ]);
      prisma.participant.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ eventId: 'evt-1', _count: { _all: 5 } }]);
      prisma.attendance.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { eventId: 'evt-1', status: 'Present', _count: { _all: 3 } },
        ]);
      prisma.eventTask.groupBy.mockResolvedValue([]);

      const summary = await service.getSummary();
      const evt1 = summary.attendance.byEvent[0];

      expect(evt1).toMatchObject({
        registered: 5,
        present: 3,
        absent: 0,
        missing: 2,
        presentRate: 0.6,
        absentRate: 0.4,
      });
    });

    it('returns zero rates when there is no data', async () => {
      const summary = await service.getSummary();

      expect(summary.events.total).toBe(0);
      expect(summary.attendance.presentRate).toBe(0);
      expect(summary.attendance.absentRate).toBe(0);
      expect(summary.tasks.completionRate).toBe(0);
      expect(summary.attendance.byEvent).toEqual([]);
    });
  });

  describe('getEventReport', () => {
    it('throws NotFound for unknown event', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.getEventReport('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('builds stats and absentee list for a completed event', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent());
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1', {
          externalName: null,
          user: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
          },
          attendance: [
            { status: 'Present', timeIn: new Date(), timeOut: new Date() },
          ],
        }),
        participantRow('p2', {
          attendance: [
            { status: 'Absent', timeIn: null, timeOut: null },
          ],
        }),
        participantRow('p3'),
      ]);
      prisma.attendance.findMany.mockResolvedValue([
        { status: 'Present' },
        { status: 'Absent' },
      ]);
      prisma.eventTask.groupBy.mockResolvedValue([
        { status: 'Done', _count: { _all: 2 } },
        { status: 'Todo', _count: { _all: 2 } },
      ]);

      const report: EventReport = await service.getEventReport('evt-1');

      expect(report.event.title).toBe('Spring Fair');
      expect(report.event.eventType).toBe('Fair');
      expect(report.stats).toEqual({
        registered: 3,
        present: 1,
        absent: 1,
        missing: 1,
        absentees: 2,
        presentRate: 0.3333,
        absentRate: 0.6667,
      });
      expect(report.participants).toHaveLength(3);
      expect(report.absentees.map((row) => row.participantId)).toEqual([
        'p2',
        'p3',
      ]);
      expect(report.absentees[0].absenteeReason).toBe('Marked Absent');
      expect(report.absentees[1].absenteeReason).toBe(
        'No attendance record (event ended)',
      );
      expect(report.participants[0].name).toBe('Ada Lovelace');
      expect(report.participants[0].email).toBe('ada@example.com');
      expect(report.tasks).toEqual({
        total: 4,
        done: 2,
        completionRate: 0.5,
      });
      expect(report.participantTypes).toEqual([
        { type: 'Guest', count: 3 },
      ]);
    });

    it('does not treat missing attendance as absentee for ongoing events', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Ongoing' }),
      );
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1'),
        participantRow('p2', {
          attendance: [{ status: 'Present', timeIn: new Date(), timeOut: null }],
        }),
      ]);
      prisma.attendance.findMany.mockResolvedValue([{ status: 'Present' }]);
      prisma.eventTask.groupBy.mockResolvedValue([]);

      const report = await service.getEventReport('evt-1');

      expect(report.absentees).toHaveLength(0);
      expect(report.stats).toMatchObject({
        registered: 2,
        present: 1,
        absent: 0,
        missing: 1,
        absentees: 0,
        presentRate: 0.5,
        absentRate: 0,
      });
    });
  });

  describe('CSV exports', () => {
    it('attendance CSV includes absentee rows and reasons', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent());
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1', {
          externalName: null,
          user: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            email: 'ada@example.com',
          },
          attendance: [
            { status: 'Present', timeIn: new Date(), timeOut: new Date() },
          ],
        }),
        participantRow('p2', {
          externalName: 'Walk-in, Guest "X"',
          attendance: [{ status: 'Absent', timeIn: null, timeOut: null }],
        }),
        participantRow('p3'),
      ]);
      prisma.attendance.findMany.mockResolvedValue([
        { status: 'Present' },
        { status: 'Absent' },
      ]);
      prisma.eventTask.groupBy.mockResolvedValue([]);

      const file = await service.exportAttendanceCsv('evt-1');
      const csv = file.buffer.toString('utf8');
      const lines = csv.trim().split('\r\n');

      expect(file.filename).toBe('spring-fair-attendance.csv');
      expect(file.mimeType).toContain('text/csv');
      expect(lines[0]).toBe(
        'participantId,name,participantType,email,attendanceStatus,timeIn,timeOut,isAbsentee,absenteeReason',
      );
      expect(lines).toHaveLength(4);
      expect(lines[2]).toContain('"Walk-in, Guest ""X"""');
      expect(lines[2]).toContain(',Absent,,,Yes,Marked Absent');
      expect(lines[3]).toContain(
        ',No record,,,Yes,No attendance record (event ended)',
      );
      expect(csv.split('\r\n').filter((line) => line.includes(',Yes,')).length).toBe(
        2,
      );
    });

    it('participants CSV includes an absentee list section', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent());
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1', {
          attendance: [
            { status: 'Present', timeIn: new Date(), timeOut: new Date() },
          ],
        }),
        participantRow('p2', {
          attendance: [{ status: 'Absent', timeIn: null, timeOut: null }],
        }),
        participantRow('p3'),
      ]);
      prisma.attendance.findMany.mockResolvedValue([
        { status: 'Present' },
        { status: 'Absent' },
      ]);
      prisma.eventTask.groupBy.mockResolvedValue([]);

      const file = await service.exportParticipantsCsv('evt-1');
      const csv = file.buffer.toString('utf8');

      expect(file.filename).toBe('spring-fair-participants.csv');
      expect(csv).toContain(
        'participantId,name,participantType,email,attendanceStatus,isAbsentee,absenteeReason',
      );
      expect(csv).toContain('Absentees: 2');
      expect(csv).toContain('Marked Absent');
      expect(csv).toContain('No attendance record (event ended)');
      expect(csv).toContain('p1');
      expect(csv).toContain(',Yes,');
    });

    it('escapes commas and quotes in absentee section names', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent());
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1', {
          externalName: 'Walk-in, Guest "X"',
          attendance: [{ status: 'Absent', timeIn: null, timeOut: null }],
        }),
      ]);
      prisma.attendance.findMany.mockResolvedValue([{ status: 'Absent' }]);
      prisma.eventTask.groupBy.mockResolvedValue([]);

      const file = await service.exportParticipantsCsv('evt-1');
      const csv = file.buffer.toString('utf8');
      const section = csv.split('Absentees: 1\r\n')[1];
      const absenteeLine = section.split('\r\n')[0];

      expect(absenteeLine).toBe(
        'p1,"Walk-in, Guest ""X""",Guest,,,Yes,Marked Absent',
      );
      expect(section.trim().split('\r\n')).toHaveLength(1);
    });
  });

  describe('PDF export', () => {
    it('returns a PDF buffer with expected filename', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent());
      prisma.participant.findMany.mockResolvedValue([
        participantRow('p1', {
          attendance: [
            { status: 'Present', timeIn: new Date(), timeOut: new Date() },
          ],
        }),
        participantRow('p2', {
          attendance: [{ status: 'Absent', timeIn: null, timeOut: null }],
        }),
      ]);
      prisma.attendance.findMany.mockResolvedValue([
        { status: 'Present' },
        { status: 'Absent' },
      ]);
      prisma.eventTask.groupBy.mockResolvedValue([
        { status: 'Done', _count: { _all: 1 } },
      ]);

      const file = await service.exportEventPdf('evt-1');

      expect(file.filename).toBe('spring-fair-report.pdf');
      expect(file.mimeType).toBe('application/pdf');
      expect(file.buffer.length).toBeGreaterThan(100);
      expect(file.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    });
  });
});

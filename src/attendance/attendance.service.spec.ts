import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { AttendanceService } from './attendance.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';

type AttendanceRow = {
  id: string;
  eventId: string;
  participantId: string;
  timeIn: Date | null;
  timeOut: Date | null;
  status: 'Present' | 'Absent';
  clientRecordId: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MockAttendanceStore = {
  rows: AttendanceRow[];
  prisma: {
    event: { findUnique: ReturnType<typeof vi.fn> };
    participant: { findFirst: ReturnType<typeof vi.fn> };
    attendance: {
      findUnique: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
  };
};

function uniqueViolation(): Error & { code: string } {
  const error = new Error('Unique constraint failed') as Error & {
    code: string;
  };
  error.code = 'P2002';
  return error;
}

function makeStore(): MockAttendanceStore {
  const rows: AttendanceRow[] = [];
  let nextId = 1;

  const attendance = {
    findUnique: vi.fn(async (args: {
      where: { id?: string; clientRecordId?: string };
    }) => {
      if (args.where.clientRecordId !== undefined) {
        return (
          rows.find((row) => row.clientRecordId === args.where.clientRecordId) ??
          null
        );
      }
      return rows.find((row) => row.id === args.where.id) ?? null;
    }),
    findFirst: vi.fn(async (args: {
      where: { eventId: string; participantId: string };
    }) => {
      return (
        rows.find(
          (row) =>
            row.eventId === args.where.eventId &&
            row.participantId === args.where.participantId,
        ) ?? null
      );
    }),
    findMany: vi.fn(async () => [...rows]),
    create: vi.fn(async (args: {
      data: Partial<AttendanceRow> & {
        eventId: string;
        participantId: string;
      };
    }) => {
      const data = args.data;
      if (
        data.clientRecordId &&
        rows.some((row) => row.clientRecordId === data.clientRecordId)
      ) {
        throw uniqueViolation();
      }
      if (
        rows.some(
          (row) =>
            row.eventId === data.eventId &&
            row.participantId === data.participantId,
        )
      ) {
        throw uniqueViolation();
      }
      const now = new Date();
      const row: AttendanceRow = {
        id: `att-${nextId++}`,
        timeIn: null,
        timeOut: null,
        status: 'Present',
        clientRecordId: null,
        syncedAt: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      } as AttendanceRow;
      rows.push(row);
      return row;
    }),
    update: vi.fn(
      async (args: {
        where: { id: string };
        data: Partial<AttendanceRow>;
        include?: unknown;
      }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (!row) {
          throw new Error('Record not found');
        }
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    ),
  };

  const prisma = {
    event: { findUnique: vi.fn() },
    participant: {
      findFirst: vi.fn().mockResolvedValue({ id: 'p-1' }),
      findUnique: vi.fn().mockResolvedValue({
        id: 'p-1',
        externalName: null,
        participantType: 'Student',
        user: null,
      }),
    },
    attendance,
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma),
  );

  return { rows, prisma };
}

type MockAudit = {
  log: ReturnType<typeof vi.fn>;
  logWith: ReturnType<typeof vi.fn>;
};

function makeAudit(): MockAudit {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logWith: vi.fn().mockResolvedValue(undefined),
  };
}

function ongoingEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'Ongoing' as EventStatus,
    ...overrides,
  };
}

function supervisor(roles: string[] = ['Department Head']): AuthUser {
  return { userId: 'sup-1', email: 'sup@hems.local', roles };
}

function coordinator(): AuthUser {
  return {
    userId: 'coord-1',
    email: 'coord@hems.local',
    roles: ['Event Coordinator'],
  };
}

function outsider(): AuthUser {
  return { userId: 'stu-1', email: 'stu@hems.local', roles: ['Student'] };
}

function syncRecord(overrides: Record<string, unknown> = {}) {
  return {
    clientRecordId: 'client-1',
    eventId: 'evt-1',
    participantId: 'p-1',
    status: 'Present' as const,
    timeIn: '2026-10-01T08:00:00.000Z',
    deviceId: 'device-1',
    recordedAt: '2026-10-01T08:00:05.000Z',
    ...overrides,
  };
}

describe('AttendanceService', () => {
  let store: MockAttendanceStore;
  let audit: MockAudit;
  let service: AttendanceService;

  beforeEach(() => {
    store = makeStore();
    audit = makeAudit();
    service = new AttendanceService(
      store.prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    store.prisma.event.findUnique.mockResolvedValue(ongoingEvent());
  });

  describe('POST /attendance/sync idempotency', () => {
    it('accepts the same clientRecordId twice and stores one row', async () => {
      const record = syncRecord();

      const first = await service.sync(supervisor(), {
        records: [record],
      });
      const second = await service.sync(supervisor(), {
        records: [record],
      });

      expect(first.accepted).toEqual(['client-1']);
      expect(first.rejected).toEqual([]);
      expect(second.accepted).toEqual(['client-1']);
      expect(second.rejected).toEqual([]);
      expect(store.rows).toHaveLength(1);
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
      expect(store.prisma.attendance.update).toHaveBeenCalledTimes(1);
    });

    it('rejects a duplicate clientRecordId within one batch instead of merging it (F11)', async () => {
      const record = syncRecord();

      const result = await service.sync(supervisor(), {
        records: [record, record],
      });

      expect(result.accepted).toEqual(['client-1']);
      expect(result.rejected).toEqual([
        {
          clientRecordId: 'client-1',
          reason: 'duplicate clientRecordId in the same batch',
        },
      ]);
      expect(store.rows).toHaveLength(1);
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
      expect(store.prisma.attendance.update).not.toHaveBeenCalled();
    });

    it('attaches a new clientRecordId to an existing participant row', async () => {
      store.prisma.attendance.findFirst.mockResolvedValueOnce({
        id: 'att-existing',
        eventId: 'evt-1',
        participantId: 'p-1',
        timeIn: null,
        timeOut: null,
        status: 'Absent',
        clientRecordId: null,
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies AttendanceRow);
      store.prisma.attendance.update.mockResolvedValueOnce({
        id: 'att-existing',
        clientRecordId: 'client-2',
      });

      const result = await service.sync(supervisor(), {
        records: [syncRecord({ clientRecordId: 'client-2' })],
      });

      expect(result.accepted).toEqual(['client-2']);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
      expect(store.prisma.attendance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-existing' },
          data: expect.objectContaining({ clientRecordId: 'client-2' }),
        }),
      );
    });

    it('audits each accepted row as attendance.sync', async () => {
      const result = await service.sync(supervisor(), {
        records: [syncRecord()],
      });

      expect(result.accepted).toEqual(['client-1']);
      expect(audit.logWith).toHaveBeenCalledTimes(1);
      expect(audit.logWith).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          method: 'POST',
          path: '/attendance/sync',
          body: expect.objectContaining({
            action: 'attendance.sync',
            clientRecordId: 'client-1',
            eventId: 'evt-1',
            participantId: 'p-1',
            deviceId: 'device-1',
          }),
        }),
      );
    });
  });

  describe('authorization', () => {
    it('rejects sync by a non-supervisor (403) without writing', async () => {
      await expect(
        service.sync(outsider(), { records: [syncRecord()] }),
      ).rejects.toThrow(ForbiddenException);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
      expect(store.prisma.attendance.update).not.toHaveBeenCalled();
      expect(audit.logWith).not.toHaveBeenCalled();
    });

    it('rejects online time-in by a non-supervisor (403)', async () => {
      await expect(
        service.timeIn('evt-1', outsider(), { participantId: 'p-1' }),
      ).rejects.toThrow(ForbiddenException);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('rejects online time-out by a non-supervisor (403)', async () => {
      await expect(
        service.timeOut('evt-1', outsider(), { participantId: 'p-1' }),
      ).rejects.toThrow(ForbiddenException);
      expect(store.prisma.attendance.update).not.toHaveBeenCalled();
    });
  });

  describe('event Ongoing gate and late-fix', () => {
    it('rejects sync records when event is not Ongoing and the caller has no late-fix role', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Planning' as EventStatus }),
      );

      const result = await service.sync(supervisor(['Student Officer']), {
        records: [syncRecord()],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([
        {
          clientRecordId: 'client-1',
          reason: expect.stringContaining('Ongoing') as unknown as string,
        },
      ]);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('rejects online time-in when event is not Ongoing (409) for a supervisor without the late-fix role', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Completed' as EventStatus }),
      );

      await expect(
        service.timeIn('evt-1', supervisor(['Instructor']), {
          participantId: 'p-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('allows Event Coordinator late-fix when event is not Ongoing', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Completed' as EventStatus }),
      );

      const result = await service.sync(coordinator(), {
        records: [syncRecord()],
      });

      expect(result.accepted).toEqual(['client-1']);
      expect(result.rejected).toEqual([]);
      expect(store.rows).toHaveLength(1);
    });

    it('allows Coordinator online time-in as late-fix after completion', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Completed' as EventStatus }),
      );

      await expect(
        service.timeIn('evt-1', coordinator(), { participantId: 'p-1' }),
      ).resolves.toEqual(
        expect.objectContaining({ status: 'Present', participantId: 'p-1' }),
      );
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
    });

    it('allows Admin late-fix time-in after completion (F10)', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Completed' as EventStatus }),
      );

      await expect(
        service.timeIn('evt-1', supervisor(['Admin']), { participantId: 'p-1' }),
      ).resolves.toEqual(
        expect.objectContaining({ status: 'Present', participantId: 'p-1' }),
      );
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
    });

    it('allows Department Head late-fix time-in after completion (F10)', async () => {
      store.prisma.event.findUnique.mockResolvedValue(
        ongoingEvent({ status: 'Completed' as EventStatus }),
      );

      await expect(
        service.timeIn('evt-1', supervisor(['Department Head']), {
          participantId: 'p-1',
        }),
      ).resolves.toEqual(
        expect.objectContaining({ status: 'Present', participantId: 'p-1' }),
      );
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync validation rejects', () => {
    it('rejects a record whose event is missing', async () => {
      store.prisma.event.findUnique.mockResolvedValue(null);

      const result = await service.sync(supervisor(), {
        records: [syncRecord()],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([
        { clientRecordId: 'client-1', reason: 'Event not found' },
      ]);
    });

    it('rejects a record whose participant is not on the event', async () => {
      store.prisma.participant.findFirst.mockResolvedValue(null);

      const result = await service.sync(supervisor(), {
        records: [syncRecord()],
      });

      expect(result.accepted).toEqual([]);
      expect(result.rejected).toEqual([
        {
          clientRecordId: 'client-1',
          reason: 'Participant not found for this event',
        },
      ]);
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('rejects online time-in when participant is not on the event (404)', async () => {
      store.prisma.participant.findFirst.mockResolvedValue(null);

      await expect(
        service.timeIn('evt-1', supervisor(), { participantId: 'p-missing' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('online time-in and time-out', () => {
    it('creates a Present row with timeIn', async () => {
      const result = await service.timeIn('evt-1', supervisor(), {
        participantId: 'p-1',
      });

      expect(result.status).toBe('Present');
      expect(result.timeIn).toBeInstanceOf(Date);
      expect(store.prisma.attendance.create).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when participant already timed in', async () => {
      store.prisma.attendance.findFirst.mockResolvedValueOnce({
        id: 'att-1',
        eventId: 'evt-1',
        participantId: 'p-1',
        timeIn: new Date('2026-10-01T08:00:00.000Z'),
        timeOut: null,
        status: 'Present',
        clientRecordId: null,
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies AttendanceRow);
      store.prisma.participant.findUnique.mockResolvedValue({
        id: 'p-1',
        externalName: null,
        participantType: 'Student',
        user: null,
      });

      const result = await service.timeIn('evt-1', supervisor(), {
        participantId: 'p-1',
      });

      expect(result.timeIn?.toISOString()).toBe(
        '2026-10-01T08:00:00.000Z',
      );
      expect(store.prisma.attendance.update).not.toHaveBeenCalled();
      expect(store.prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('rejects time-out before time-in exists (409)', async () => {
      store.prisma.attendance.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.timeOut('evt-1', supervisor(), { participantId: 'p-1' }),
      ).rejects.toThrow(ConflictException);
    });

    it('sets timeOut on existing time-in', async () => {
      const timeIn = new Date(Date.now() - 60 * 60 * 1000);
      store.prisma.attendance.findFirst.mockResolvedValueOnce({
        id: 'att-1',
        eventId: 'evt-1',
        participantId: 'p-1',
        timeIn,
        timeOut: null,
        status: 'Present',
        clientRecordId: null,
        syncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } satisfies AttendanceRow);
      store.prisma.attendance.update.mockImplementation(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({
          id: args.where.id,
          eventId: 'evt-1',
          participantId: 'p-1',
          timeIn,
          timeOut: args.data.timeOut,
          status: 'Present',
          clientRecordId: null,
          syncedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      store.prisma.participant.findUnique.mockResolvedValue({
        id: 'p-1',
        externalName: null,
        participantType: 'Student',
        user: null,
      });

      const result = await service.timeOut('evt-1', supervisor(), {
        participantId: 'p-1',
      });

      expect(result.timeOut).toBeInstanceOf(Date);
      expect(store.prisma.attendance.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'att-1' },
          data: expect.objectContaining({ timeOut: expect.any(Date) }),
        }),
      );
    });
  });

  describe('list', () => {
    it('404 when event missing', async () => {
      store.prisma.event.findUnique.mockResolvedValue(null);

      await expect(service.findMany('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns attendance rows for the event', async () => {
      const rows = await service.findMany('evt-1');
      expect(Array.isArray(rows)).toBe(true);
      expect(store.prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'evt-1' } }),
      );
    });
  });

  describe('my attendance history', () => {
    it("returns the user's attendance rows joined with events", async () => {
      const event = {
        id: 'e1',
        title: 'Spring Fair',
        eventType: { id: 't1', name: 'Fair' },
      };
      const attendance = {
        id: 'att-1',
        eventId: 'e1',
        participantId: 'p1',
        status: 'Present',
        timeIn: new Date('2026-05-01T08:00:00Z'),
        timeOut: new Date('2026-05-01T10:00:00Z'),
        clientRecordId: null,
        syncedAt: null,
        createdAt: new Date('2026-05-01'),
        updatedAt: new Date('2026-05-01'),
        participant: {
          id: 'p1',
          externalName: null,
          participantType: 'Student',
          user: {
            id: 'stu-1',
            firstName: 'Stu',
            lastName: 'Dent',
            email: 'stu@hems.local',
          },
        },
        event,
      };
      store.prisma.attendance.findMany.mockResolvedValue([attendance]);

      const result = await service.findMine(outsider());

      expect(store.prisma.attendance.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { participant: { userId: 'stu-1' } },
          orderBy: [{ event: { eventDate: 'desc' } }, { createdAt: 'desc' }],
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].event).toBe(event);
      expect(result[0].attendance).not.toHaveProperty('event');
      expect(result[0].attendance.id).toBe('att-1');
    });

    it('returns an empty history when the user attended nothing', async () => {
      store.prisma.attendance.findMany.mockResolvedValue([]);

      await expect(service.findMine(outsider())).resolves.toEqual([]);
    });
  });
});

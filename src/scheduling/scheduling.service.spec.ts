import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { SchedulingService } from './scheduling.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: { findUnique: ReturnType<typeof vi.fn> };
  committeeMember: { findFirst: ReturnType<typeof vi.fn> };
  eventSchedule: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function makePrisma(): MockPrisma {
  return {
    event: { findUnique: vi.fn() },
    committeeMember: { findFirst: vi.fn().mockResolvedValue(null) },
    eventSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'Approved' as EventStatus,
    createdById: 'owner-1',
    ...overrides,
  };
}

function owner(): AuthUser {
  return {
    userId: 'owner-1',
    email: 'owner@hems.local',
    roles: ['Event Coordinator'],
  };
}

function outsider(): AuthUser {
  return { userId: 'x', email: 'x@hems.local', roles: ['Student'] };
}

function createDto(overrides: Record<string, unknown> = {}) {
  return {
    activityName: 'Registration',
    startTime: '2026-10-01T08:00:00.000Z',
    endTime: '2026-10-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('SchedulingService', () => {
  let prisma: MockPrisma;
  let service: SchedulingService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new SchedulingService(prisma as unknown as PrismaService);
    prisma.event.findUnique.mockResolvedValue(baseEvent());
  });

  describe('createTime validation (endTime > startTime)', () => {
    it('creates when endTime is after startTime', async () => {
      await expect(
        service.create('evt-1', owner(), createDto()),
      ).resolves.toEqual({});
      expect(prisma.eventSchedule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'evt-1',
          activityName: 'Registration',
          startTime: new Date('2026-10-01T08:00:00.000Z'),
          endTime: new Date('2026-10-01T09:00:00.000Z'),
        }),
      });
    });

    it('rejects endTime equal to startTime (400)', async () => {
      await expect(
        service.create(
          'evt-1',
          owner(),
          createDto({ endTime: '2026-10-01T08:00:00.000Z' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.eventSchedule.create).not.toHaveBeenCalled();
    });

    it('rejects endTime before startTime (400)', async () => {
      await expect(
        service.create(
          'evt-1',
          owner(),
          createDto({ endTime: '2026-10-01T07:00:00.000Z' }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.eventSchedule.create).not.toHaveBeenCalled();
    });
  });

  describe('update time validation', () => {
    function existingSchedule() {
      return {
        id: 's-1',
        eventId: 'evt-1',
        activityName: 'Registration',
        startTime: new Date('2026-10-01T08:00:00.000Z'),
        endTime: new Date('2026-10-01T09:00:00.000Z'),
      };
    }

    it('rejects endTime update that crosses existing startTime (400)', async () => {
      prisma.eventSchedule.findFirst.mockResolvedValueOnce(
        existingSchedule(),
      );

      await expect(
        service.update('evt-1', 's-1', owner(), {
          endTime: '2026-10-01T07:30:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.eventSchedule.update).not.toHaveBeenCalled();
    });

    it('rejects startTime update past existing endTime (400)', async () => {
      prisma.eventSchedule.findFirst.mockResolvedValueOnce(
        existingSchedule(),
      );

      await expect(
        service.update('evt-1', 's-1', owner(), {
          startTime: '2026-10-01T10:00:00.000Z',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.eventSchedule.update).not.toHaveBeenCalled();
    });

    it('accepts partial startTime update that keeps order', async () => {
      prisma.eventSchedule.findFirst.mockResolvedValueOnce(
        existingSchedule(),
      );

      await expect(
        service.update('evt-1', 's-1', owner(), {
          startTime: '2026-10-01T08:30:00.000Z',
        }),
      ).resolves.toEqual({});
      expect(prisma.eventSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's-1' },
          data: {
            startTime: new Date('2026-10-01T08:30:00.000Z'),
          },
        }),
      );
    });

    it('updates activityName without touching times', async () => {
      prisma.eventSchedule.findFirst.mockResolvedValueOnce(
        existingSchedule(),
      );

      await service.update('evt-1', 's-1', owner(), {
        activityName: 'Opening',
      });

      expect(prisma.eventSchedule.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { activityName: 'Opening' },
        }),
      );
    });
  });

  describe('RBAC', () => {
    it('forbids create by outsider (403)', async () => {
      await expect(
        service.create('evt-1', outsider(), createDto()),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.eventSchedule.create).not.toHaveBeenCalled();
    });

    it('allows create by committee member', async () => {
      prisma.committeeMember.findFirst.mockResolvedValueOnce({ id: 'cm-1' });
      const member: AuthUser = {
        userId: 'm1',
        email: 'm@hems.local',
        roles: ['Student Officer'],
      };

      await expect(
        service.create('evt-1', member, createDto()),
      ).resolves.toEqual({});
      expect(prisma.eventSchedule.create).toHaveBeenCalled();
    });

    it('allows delete by Admin', async () => {
      const admin: AuthUser = {
        userId: 'a1',
        email: 'a@hems.local',
        roles: ['Admin'],
      };
      prisma.eventSchedule.findFirst.mockResolvedValueOnce({ id: 's-1' });

      await expect(service.remove('evt-1', 's-1', admin)).resolves.toBeUndefined();
      expect(prisma.eventSchedule.delete).toHaveBeenCalledWith({
        where: { id: 's-1' },
      });
    });

    it('forbids delete by outsider (403)', async () => {
      await expect(service.remove('evt-1', 's-1', outsider())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.eventSchedule.delete).not.toHaveBeenCalled();
    });
  });

  describe('status gate', () => {
    it('blocks create when event is Cancelled (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );

      await expect(
        service.create('evt-1', owner(), createDto()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.eventSchedule.create).not.toHaveBeenCalled();
    });

    it('allows create when event is Draft', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Draft' }),
      );

      await expect(
        service.create('evt-1', owner(), createDto()),
      ).resolves.toEqual({});
      expect(prisma.eventSchedule.create).toHaveBeenCalled();
    });
  });

  describe('lookups', () => {
    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findMany('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404 when schedule entry not on this event', async () => {
      prisma.eventSchedule.findFirst.mockResolvedValueOnce(null);

      await expect(service.remove('evt-1', 's-1', owner())).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.eventSchedule.delete).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { ParticipantsService } from './participants.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  participant: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function makePrisma(): MockPrisma {
  return {
    event: { findUnique: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u-1' }) },
    participant: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
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

function student(id = 'student-1'): AuthUser {
  return { userId: id, email: 's@hems.local', roles: ['Student'] };
}

describe('ParticipantsService', () => {
  let prisma: MockPrisma;
  let service: ParticipantsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ParticipantsService(prisma as unknown as PrismaService);
    prisma.event.findUnique.mockResolvedValue(baseEvent());
  });

  describe('external-guest path (userId XOR externalName)', () => {
    it('creates a guest participant with null userId from externalName', async () => {
      const result = await service.add('evt-1', owner(), {
        externalName: 'Walk-in Guest',
      });

      expect(result).toEqual({});
      expect(prisma.participant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'evt-1',
          userId: null,
          externalName: 'Walk-in Guest',
          participantType: 'Guest',
          registrationStatus: 'Registered',
        }),
        include: expect.any(Object),
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rejects both userId and externalName (400)', async () => {
      await expect(
        service.add('evt-1', owner(), {
          userId: 'u-1',
          externalName: 'Ghost',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('rejects neither userId nor externalName (400)', async () => {
      await expect(service.add('evt-1', owner(), {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate external name case-insensitively (409)', async () => {
      prisma.participant.findFirst.mockResolvedValueOnce({ id: 'p-1' });

      await expect(
        service.add('evt-1', owner(), { externalName: 'walk-in guest' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate system-user participant (409)', async () => {
      prisma.participant.findFirst.mockResolvedValueOnce({ id: 'p-2' });

      await expect(
        service.add('evt-1', owner(), { userId: 'u-1' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('rejects unknown system user (404)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.add('evt-1', owner(), { userId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });
  });

  describe('status gate', () => {
    it.each(['Draft', 'PendingApproval', 'RevisionRequired', 'Rejected', 'Cancelled'] as const)(
      'blocks add when event is %s (409)',
      async (status) => {
        prisma.event.findUnique.mockResolvedValue(baseEvent({ status }));

        await expect(
          service.add('evt-1', owner(), { externalName: 'Guest' }),
        ).rejects.toThrow(ConflictException);
        expect(prisma.participant.create).not.toHaveBeenCalled();
      },
    );

    it('blocks self-register when event is Draft (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(baseEvent({ status: 'Draft' }));

      await expect(service.selfRegister('evt-1', student())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('blocks remove when event is Cancelled (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );

      await expect(service.remove('evt-1', 'p-1', owner())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.participant.delete).not.toHaveBeenCalled();
    });

    it('allows add when event is Planning', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Planning' }),
      );

      await expect(
        service.add('evt-1', owner(), { externalName: 'OK Guest' }),
      ).resolves.toEqual({});
      expect(prisma.participant.create).toHaveBeenCalled();
    });
  });

  describe('RBAC', () => {
    it('student self-registers as Student/Registered', async () => {
      const result = await service.selfRegister('evt-1', student());

      expect(result).toEqual({});
      expect(prisma.participant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'evt-1',
          userId: 'student-1',
          externalName: null,
          participantType: 'Student',
          registrationStatus: 'Registered',
        }),
        include: expect.any(Object),
      });
    });

    it('Student Officer can self-register', async () => {
      const officer: AuthUser = {
        userId: 'off-1',
        email: 'o@hems.local',
        roles: ['Student Officer'],
      };
      await expect(service.selfRegister('evt-1', officer)).resolves.toEqual({});
    });

    it('forbids self-register for non-student roles', async () => {
      await expect(
        service.selfRegister('evt-1', {
          userId: 'coord',
          email: 'c@hems.local',
          roles: ['Instructor'],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('forbids add by non-owner without create role', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.add(
          'evt-1',
          { userId: 'x', email: 'x@hems.local', roles: ['Student'] },
          { externalName: 'Guest' },
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.participant.create).not.toHaveBeenCalled();
    });

    it('forbids remove by non-owner without create role', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.remove('evt-1', 'p-1', {
          userId: 'x',
          email: 'x@hems.local',
          roles: ['Student'],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.participant.delete).not.toHaveBeenCalled();
    });

    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findMany('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('owner removes participant scoped to event', async () => {
      prisma.participant.findFirst.mockResolvedValueOnce({ id: 'p-1' });

      await service.remove('evt-1', 'p-1', owner());

      expect(prisma.participant.findFirst).toHaveBeenCalledWith({
        where: { id: 'p-1', eventId: 'evt-1' },
      });
      expect(prisma.participant.delete).toHaveBeenCalledWith({
        where: { id: 'p-1' },
      });
    });

    it('404 when participant not on this event', async () => {
      prisma.participant.findFirst.mockResolvedValueOnce(null);

      await expect(service.remove('evt-1', 'p-1', owner())).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.participant.delete).not.toHaveBeenCalled();
    });
  });
});

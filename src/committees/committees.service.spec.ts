import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { CommitteesService } from './committees.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  committee: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUniqueOrThrow: ReturnType<typeof vi.fn>;
  };
  committeeMember: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function makePrisma(): MockPrisma {
  return {
    event: { findUnique: vi.fn() },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'u-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@hems.local',
      }),
    },
    committee: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      findUniqueOrThrow: vi.fn().mockResolvedValue({}),
    },
    committeeMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'Planning' as EventStatus,
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

const admin: AuthUser = {
  userId: 'a1',
  email: 'a@hems.local',
  roles: ['Admin'],
};

const head: AuthUser = {
  userId: 'h1',
  email: 'h@hems.local',
  roles: ['Department Head'],
};

const stranger: AuthUser = {
  userId: 's1',
  email: 's@hems.local',
  roles: ['Student'],
};

describe('CommitteesService', () => {
  let prisma: MockPrisma;
  let service: CommitteesService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new CommitteesService(prisma as unknown as PrismaService);
    prisma.event.findUnique.mockResolvedValue(baseEvent());
  });

  describe('create', () => {
    it('owner creates a committee on a Planning event', async () => {
      await service.create('evt-1', owner(), { name: ' Steering ', description: 'x' });

      expect(prisma.committee.create).toHaveBeenCalledWith({
        data: { eventId: 'evt-1', name: 'Steering', description: 'x' },
        include: expect.any(Object),
      });
    });

    it('Admin and Department Head can create', async () => {
      await expect(
        service.create('evt-1', admin, { name: 'Ops' }),
      ).resolves.toEqual({});
      await expect(
        service.create('evt-1', head, { name: 'Ops' }),
      ).resolves.toEqual({});
      expect(prisma.committee.create).toHaveBeenCalledTimes(2);
    });

    it('forbids create by non-owner without manager role', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.create('evt-1', stranger, { name: 'Nope' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.committee.create).not.toHaveBeenCalled();
    });

    it('status gate blocks create on Cancelled event (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );

      await expect(
        service.create('evt-1', owner(), { name: 'Steering' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.committee.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate committee name case-insensitively (409)', async () => {
      prisma.committee.findFirst.mockResolvedValueOnce({ id: 'cm-1' });

      await expect(
        service.create('evt-1', owner(), { name: 'steering' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.committee.create).not.toHaveBeenCalled();
    });
  });

  describe('add/remove members (E2E-style service flow)', () => {
    beforeEach(() => {
      prisma.committee.findFirst.mockResolvedValue({
        id: 'cm-1',
        eventId: 'evt-1',
        name: 'Steering',
      });
    });

    it('adds a member then removes them', async () => {
      await service.addMember('evt-1', 'cm-1', owner(), { userId: 'u-1' });
      expect(prisma.committeeMember.create).toHaveBeenCalledWith({
        data: { committeeId: 'cm-1', userId: 'u-1' },
      });

      prisma.committeeMember.findUnique.mockResolvedValueOnce({
        committeeId: 'cm-1',
        userId: 'u-1',
      });
      await service.removeMember('evt-1', 'cm-1', 'u-1', owner());
      expect(prisma.committeeMember.delete).toHaveBeenCalledWith({
        where: { committeeId_userId: { committeeId: 'cm-1', userId: 'u-1' } },
      });
    });

    it('rejects duplicate member (409)', async () => {
      prisma.committeeMember.findUnique.mockResolvedValueOnce({
        committeeId: 'cm-1',
        userId: 'u-1',
      });

      await expect(
        service.addMember('evt-1', 'cm-1', owner(), { userId: 'u-1' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.committeeMember.create).not.toHaveBeenCalled();
    });

    it('rejects unknown user (404)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.addMember('evt-1', 'cm-1', owner(), { userId: 'missing' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.committeeMember.create).not.toHaveBeenCalled();
    });

    it('status gate blocks add/remove on a Cancelled event (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );

      await expect(
        service.addMember('evt-1', 'cm-1', owner(), { userId: 'u-1' }),
      ).rejects.toThrow(ConflictException);
      await expect(
        service.removeMember('evt-1', 'cm-1', 'u-1', owner()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.committeeMember.create).not.toHaveBeenCalled();
      expect(prisma.committeeMember.delete).not.toHaveBeenCalled();
    });

    it('forbids member ops by stranger; allows Admin', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.addMember('evt-1', 'cm-1', stranger, { userId: 'u-1' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.addMember('evt-1', 'cm-1', admin, { userId: 'u-1' }),
      ).resolves.toEqual({});
    });

    it('404 when committee not on this event', async () => {
      prisma.committee.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.addMember('evt-1', 'missing', owner(), { userId: 'u-1' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.committeeMember.create).not.toHaveBeenCalled();
    });

    it('404 when removing non-member', async () => {
      prisma.committeeMember.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.removeMember('evt-1', 'cm-1', 'u-1', owner()),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.committeeMember.delete).not.toHaveBeenCalled();
    });
  });
});

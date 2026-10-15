import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { TasksService } from './tasks.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: { findUnique: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  committeeMember: { findFirst: ReturnType<typeof vi.fn> };
  eventTask: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

type MockNotifications = {
  notify: ReturnType<typeof vi.fn>;
};

function makeNotifications(): MockNotifications {
  return { notify: vi.fn().mockResolvedValue(undefined) };
}

function makePrisma(): MockPrisma {
  return {
    event: { findUnique: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'u-1' }) },
    committeeMember: { findFirst: vi.fn().mockResolvedValue(null) },
    eventTask: {
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

function outsider(): AuthUser {
  return {
    userId: 'x',
    email: 'x@hems.local',
    roles: ['Student'],
  };
}

function createDto(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Book venue',
    deadline: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('TasksService', () => {
  let prisma: MockPrisma;
  let notifications: MockNotifications;
  let service: TasksService;

  beforeEach(() => {
    prisma = makePrisma();
    notifications = makeNotifications();
    service = new TasksService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
    prisma.event.findUnique.mockResolvedValue(baseEvent());
  });

  describe('RBAC', () => {
    it('forbids create by outsider without committee membership (403)', async () => {
      await expect(
        service.create('evt-1', outsider(), createDto()),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.eventTask.create).not.toHaveBeenCalled();
    });

    it('allows create by event owner', async () => {
      await expect(
        service.create('evt-1', owner(), createDto()),
      ).resolves.toEqual({});
      expect(prisma.eventTask.create).toHaveBeenCalled();
    });

    it('allows create by Admin without committee membership', async () => {
      const admin: AuthUser = {
        userId: 'a1',
        email: 'a@hems.local',
        roles: ['Admin'],
      };
      await expect(service.create('evt-1', admin, createDto())).resolves.toEqual(
        {},
      );
      expect(prisma.committeeMember.findFirst).not.toHaveBeenCalled();
      expect(prisma.eventTask.create).toHaveBeenCalled();
    });

    it('allows create by Department Head without committee membership', async () => {
      const head: AuthUser = {
        userId: 'h1',
        email: 'h@hems.local',
        roles: ['Department Head'],
      };
      await expect(service.create('evt-1', head, createDto())).resolves.toEqual(
        {},
      );
      expect(prisma.eventTask.create).toHaveBeenCalled();
    });

    it('allows create by committee member of this event', async () => {
      prisma.committeeMember.findFirst.mockResolvedValueOnce({ id: 'cm-1' });
      const member: AuthUser = {
        userId: 'm1',
        email: 'm@hems.local',
        roles: ['Student Officer'],
      };

      await expect(
        service.create('evt-1', member, createDto()),
      ).resolves.toEqual({});
      expect(prisma.committeeMember.findFirst).toHaveBeenCalledWith({
        where: { userId: 'm1', committee: { eventId: 'evt-1' } },
        select: { id: true },
      });
      expect(prisma.eventTask.create).toHaveBeenCalled();
    });

    it('forbids update by outsider (403)', async () => {
      await expect(
        service.update('evt-1', 't-1', outsider(), { status: 'Done' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.eventTask.update).not.toHaveBeenCalled();
    });

    it('forbids delete by outsider (403)', async () => {
      await expect(service.remove('evt-1', 't-1', outsider())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.eventTask.delete).not.toHaveBeenCalled();
    });

    it('allows update by committee member', async () => {
      prisma.committeeMember.findFirst.mockResolvedValueOnce({ id: 'cm-1' });
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });
      const member: AuthUser = {
        userId: 'm1',
        email: 'm@hems.local',
        roles: ['Student Officer'],
      };

      await expect(
        service.update('evt-1', 't-1', member, { status: 'Done' }),
      ).resolves.toEqual({});
      expect(prisma.eventTask.update).toHaveBeenCalled();
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
      expect(prisma.eventTask.create).not.toHaveBeenCalled();
    });

    it('allows create when event is Planning (planning-anytime choice)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Planning' }),
      );

      await expect(
        service.create('evt-1', owner(), createDto()),
      ).resolves.toEqual({});
      expect(prisma.eventTask.create).toHaveBeenCalled();
    });

    it('blocks delete when event is Cancelled (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );

      await expect(service.remove('evt-1', 't-1', owner())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.eventTask.delete).not.toHaveBeenCalled();
    });
  });

  describe('status toggle and updates', () => {
    it('toggles status Todo -> Done', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });

      await service.update('evt-1', 't-1', owner(), { status: 'Done' });

      expect(prisma.eventTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 't-1' },
          data: expect.objectContaining({ status: 'Done' }),
        }),
      );
    });

    it('updates deadline as Date', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });

      await service.update('evt-1', 't-1', owner(), {
        deadline: '2026-11-15T08:30:00.000Z',
      });

      expect(prisma.eventTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deadline: new Date('2026-11-15T08:30:00.000Z'),
          }),
        }),
      );
    });

    it('updates assignee and validates user exists', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });

      await service.update('evt-1', 't-1', owner(), {
        assignedToUserId: 'u-9',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'u-9' },
        select: { id: true },
      });
      expect(prisma.eventTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assignedToUser: { connect: { id: 'u-9' } },
          }),
        }),
      );
    });

    it('rejects unknown assignee (404)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.create(
          'evt-1',
          owner(),
          createDto({ assignedToUserId: 'missing' }),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.eventTask.create).not.toHaveBeenCalled();
    });

    it('clears assignee when assignedToUserId is null', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });

      await service.update('evt-1', 't-1', owner(), {
        assignedToUserId: null,
      });

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.eventTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            assignedToUser: { disconnect: true },
          }),
        }),
      );
    });
  });

  describe('notification triggers', () => {
    it('notifies the assignee on create with TaskAssigned', async () => {
      prisma.eventTask.create.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: 'u-9',
      });

      await service.create(
        'evt-1',
        owner(),
        createDto({ assignedToUserId: 'u-9' }),
      );

      expect(notifications.notify).toHaveBeenCalledWith({
        actorId: 'owner-1',
        userIds: ['u-9'],
        type: 'TaskAssigned',
        eventId: 'evt-1',
        message: expect.stringContaining('Book venue'),
      });
    });

    it('does not notify on create when there is no assignee', async () => {
      prisma.eventTask.create.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: null,
      });

      await service.create('evt-1', owner(), createDto());

      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('notifies the new assignee on reassignment', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: 'u-old',
      });
      prisma.eventTask.update.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: 'u-9',
      });

      await service.update('evt-1', 't-1', owner(), {
        assignedToUserId: 'u-9',
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'owner-1',
          userIds: ['u-9'],
          type: 'TaskAssigned',
          eventId: 'evt-1',
        }),
      );
    });

    it('does not notify when the assignee is unchanged', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: 'u-9',
      });

      await service.update('evt-1', 't-1', owner(), {
        assignedToUserId: 'u-9',
      });

      expect(notifications.notify).not.toHaveBeenCalled();
    });

    it('does not notify when the assignee is cleared', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({
        id: 't-1',
        title: 'Book venue',
        assignedToUserId: 'u-9',
      });

      await service.update('evt-1', 't-1', owner(), {
        assignedToUserId: null,
      });

      expect(notifications.notify).not.toHaveBeenCalled();
    });
  });

  describe('lookups', () => {
    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findMany('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404 when task not on this event', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce(null);

      await expect(service.remove('evt-1', 't-1', owner())).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.eventTask.delete).not.toHaveBeenCalled();
    });

    it('scopes task query to event', async () => {
      prisma.eventTask.findFirst.mockResolvedValueOnce({ id: 't-1' });

      await service.remove('evt-1', 't-1', owner());

      expect(prisma.eventTask.findFirst).toHaveBeenCalledWith({
        where: { id: 't-1', eventId: 'evt-1' },
      });
      expect(prisma.eventTask.delete).toHaveBeenCalledWith({
        where: { id: 't-1' },
      });
    });
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

type MockPrisma = {
  notification: {
    createMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };
};

function makePrisma(): MockPrisma {
  return {
    notification: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

describe('NotificationsService', () => {
  let prisma: MockPrisma;
  let service: NotificationsService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    prisma = makePrisma();
    service = new NotificationsService(prisma as unknown as PrismaService);
    warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('notify', () => {
    it('creates one notification per recipient with type, message, eventId', async () => {
      await service.notify({
        actorId: 'actor-1',
        userIds: ['u-1', 'u-2'],
        type: 'TaskAssigned',
        message: 'assigned',
        eventId: 'evt-1',
      });

      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 'u-1',
            eventId: 'evt-1',
            type: 'TaskAssigned',
            message: 'assigned',
          },
          {
            userId: 'u-2',
            eventId: 'evt-1',
            type: 'TaskAssigned',
            message: 'assigned',
          },
        ],
      });
    });

    it('skips the actor and dedupes recipients (no self-notification)', async () => {
      await service.notify({
        actorId: 'u-1',
        userIds: ['u-1', 'u-1', 'u-2'],
        type: 'TaskAssigned',
        message: 'assigned',
      });

      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          {
            userId: 'u-2',
            eventId: null,
            type: 'TaskAssigned',
            message: 'assigned',
          },
        ],
      });
    });

    it('writes nothing when the only recipient is the actor', async () => {
      await service.notify({
        actorId: 'u-1',
        userIds: ['u-1'],
        type: 'TaskAssigned',
        message: 'assigned',
      });

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('is best-effort: createMany failure does not reject', async () => {
      prisma.notification.createMany.mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(
        service.notify({
          actorId: 'a',
          userIds: ['u-1'],
          type: 'TaskAssigned',
          message: 'm',
        }),
      ).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe('findMany (list)', () => {
    it("returns the user's own notifications newest first", async () => {
      const rows = [
        { id: 'n-2', userId: 'u-1', createdAt: new Date('2026-09-20') },
        { id: 'n-1', userId: 'u-1', createdAt: new Date('2026-09-19') },
      ];
      prisma.notification.findMany.mockResolvedValueOnce(rows);

      await expect(service.findMany('u-1')).resolves.toEqual(rows);
      expect(prisma.notification.findMany).toHaveBeenCalledWith({
        where: { userId: 'u-1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('markRead', () => {
    it("marks the user's own notification read and returns it", async () => {
      const row = { id: 'n-1', userId: 'u-1', isRead: true };
      prisma.notification.findUnique.mockResolvedValueOnce(row);

      await expect(service.markRead('u-1', 'n-1')).resolves.toEqual(row);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n-1', userId: 'u-1' },
        data: { isRead: true },
      });
      expect(prisma.notification.findUnique).toHaveBeenCalledWith({
        where: { id: 'n-1' },
      });
    });

    it('404 when the notification is missing or belongs to another user', async () => {
      prisma.notification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.markRead('u-1', 'n-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    });
  });
});

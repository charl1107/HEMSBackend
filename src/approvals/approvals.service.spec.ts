import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { EventStatus } from '@prisma/client';
import { ApprovalsService } from './approvals.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  approval: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

type MockAudit = {
  log: ReturnType<typeof vi.fn>;
  logWith: ReturnType<typeof vi.fn>;
};

function makePrisma(): MockPrisma {
  const prisma: MockPrisma = {
    event: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    approval: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(
    async (fn: (tx: MockPrisma) => Promise<unknown>) => fn(prisma),
  );
  return prisma;
}

function makeAudit(): MockAudit {
  return {
    log: vi.fn().mockResolvedValue(undefined),
    logWith: vi.fn().mockResolvedValue(undefined),
  };
}

type MockNotifications = {
  notify: ReturnType<typeof vi.fn>;
  notifyRole: ReturnType<typeof vi.fn>;
};

function makeNotifications(): MockNotifications {
  return {
    notify: vi.fn().mockResolvedValue(undefined),
    notifyRole: vi.fn().mockResolvedValue(undefined),
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Gala Night',
    description: null,
    eventDate: new Date('2026-10-01T00:00:00.000Z'),
    venue: 'Main Hall',
    status: 'Draft' as EventStatus,
    coverImageUrl: null,
    eventTypeId: null,
    eventType: null,
    createdById: 'owner-1',
    createdAt: new Date('2026-09-01'),
    updatedAt: new Date('2026-09-01'),
    ...overrides,
  };
}

function ownerUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'owner-1',
    email: 'owner@hems.local',
    roles: ['Event Coordinator'],
    ...overrides,
  };
}

const headUser: AuthUser = {
  userId: 'head-1',
  email: 'head@hems.local',
  roles: ['Department Head'],
};

describe('ApprovalsService', () => {
  let prisma: MockPrisma;
  let audit: MockAudit;
  let notifications: MockNotifications;
  let service: ApprovalsService;

  beforeEach(() => {
    prisma = makePrisma();
    audit = makeAudit();
    notifications = makeNotifications();
    service = new ApprovalsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
      notifications as unknown as NotificationsService,
    );
  });

  describe('submit', () => {
    it('owner submits Draft → PendingApproval and records Submitted', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent())
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }));

      const result = await service.submit('evt-1', ownerUser(), {
        comments: 'Ready for review',
      });

      expect(result.status).toBe('PendingApproval');
      expect(prisma.approval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventId: 'evt-1',
          reviewerId: 'owner-1',
          action: 'Submitted',
          comments: 'Ready for review',
        }),
      });
      expect(prisma.event.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'Draft' },
        data: { status: 'PendingApproval' },
      });
    });

    it('submit-role user who is not owner can submit', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(
          baseEvent({ createdById: 'someone-else', status: 'RevisionRequired' }),
        )
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }));

      await expect(
        service.submit('evt-1', ownerUser({ roles: ['Student Officer'] })),
      ).resolves.toMatchObject({ status: 'PendingApproval' });
    });

    it('forbids non-owner without submit role', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(
        baseEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.submit(
          'evt-1',
          ownerUser({ userId: 'student-1', roles: ['Student'] }),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });

    it('blocks submit from invalid status (Approved)', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(
        baseEvent({ status: 'Approved' }),
      );

      await expect(service.submit('evt-1', ownerUser())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });

    it('409 when concurrent status change makes updateMany match zero rows', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent())
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }));
      prisma.event.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.submit('evt-1', ownerUser())).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.approval.create).not.toHaveBeenCalled();
    });

    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(null);
      await expect(service.submit('missing', ownerUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('approve', () => {
    it('approves PendingApproval → Planning with no conflict', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Approved' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Planning' }));
      prisma.event.findFirst.mockResolvedValue(null);

      const result = await service.approve('evt-1', headUser, {
        comments: 'ok',
      });

      expect(result.status).toBe('Planning');
      expect(result.conflictWarning).toBeNull();
      expect(prisma.approval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'Approved',
          reviewerId: 'head-1',
        }),
      });
      expect(prisma.event.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'evt-1', status: 'PendingApproval' },
        data: { status: 'Approved' },
      });
      expect(prisma.event.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'evt-1', status: 'Approved' },
        data: { status: 'Planning' },
      });
      expect(audit.log).not.toHaveBeenCalled();
      expect(audit.logWith).not.toHaveBeenCalled();
    });

    it('returns 409 with conflict payload when conflict and no override', async () => {
      const conflict = {
        id: 'other',
        title: 'Wedding Expo',
        venue: 'main hall',
        eventDate: new Date('2026-10-01T00:00:00.000Z'),
      };
      prisma.event.findUnique.mockResolvedValueOnce(
        baseEvent({ status: 'PendingApproval' }),
      );
      prisma.event.findFirst.mockResolvedValue(conflict);

      await expect(service.approve('evt-1', headUser)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({
          requiresOverride: true,
          conflict,
        }),
      });
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(audit.logWith).not.toHaveBeenCalled();
    });

    it('overrideConflict allows approve and writes override audit inside the transaction', async () => {
      const conflict = {
        id: 'other',
        title: 'Wedding Expo',
        venue: 'main hall',
        eventDate: new Date('2026-10-01T00:00:00.000Z'),
      };
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Approved' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Planning' }));
      prisma.event.findFirst.mockResolvedValue(conflict);

      const timeline: string[] = [];
      prisma.$transaction.mockImplementation(
        async (fn: (tx: MockPrisma) => Promise<unknown>) => {
          const out = await fn(prisma);
          timeline.push('tx-complete');
          return out;
        },
      );
      audit.logWith.mockImplementation(async () => {
        timeline.push('audit');
      });

      const result = await service.approve('evt-1', headUser, {
        overrideConflict: true,
      });

      expect(result.status).toBe('Planning');
      expect(result.conflictWarning).toContain('Wedding Expo');
      expect(audit.log).not.toHaveBeenCalled();
      expect(audit.logWith).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          userId: 'head-1',
          method: 'POST',
          path: '/events/evt-1/approve',
          body: expect.objectContaining({
            overrideConflict: true,
            conflict,
          }),
        }),
      );
      expect(timeline).toEqual(['audit', 'tx-complete']);
    });

    it('409 when concurrent status change makes approve updateMany match zero rows', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(
        baseEvent({ status: 'PendingApproval' }),
      );
      prisma.event.findFirst.mockResolvedValue(null);
      prisma.event.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.approve('evt-1', headUser)).rejects.toThrow(
        'event status changed',
      );
      expect(prisma.approval.create).not.toHaveBeenCalled();
      expect(audit.logWith).not.toHaveBeenCalled();
    });

    it('blocks approve when status is not PendingApproval', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(baseEvent({ status: 'Draft' }));

      await expect(service.approve('evt-1', headUser)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('reject', () => {
    it('PendingApproval → Rejected stores reason as comments', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Rejected' }));

      const result = await service.reject('evt-1', headUser, {
        reason: 'Budget missing',
      });

      expect(result.status).toBe('Rejected');
      expect(prisma.event.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'PendingApproval' },
        data: { status: 'Rejected' },
      });
      expect(prisma.approval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'Rejected',
          comments: 'Budget missing',
          reviewerId: 'head-1',
        }),
      });
    });

    it('requires non-blank reason at the service layer', async () => {
      await expect(
        service.reject('evt-1', headUser, { reason: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.event.findUnique).not.toHaveBeenCalled();
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });

    it('blocks reject from Draft', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(baseEvent({ status: 'Draft' }));
      await expect(
        service.reject('evt-1', headUser, { reason: 'no' }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('requestRevision', () => {
    it('PendingApproval → RevisionRequired with comments', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'RevisionRequired' }));

      const result = await service.requestRevision('evt-1', headUser, {
        comments: 'Add sponsor list',
      });

      expect(result.status).toBe('RevisionRequired');
      expect(prisma.event.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'PendingApproval' },
        data: { status: 'RevisionRequired' },
      });
      expect(prisma.approval.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'RevisionRequested',
          comments: 'Add sponsor list',
        }),
      });
    });

    it('requires non-blank comments at the service layer', async () => {
      await expect(
        service.requestRevision('evt-1', headUser, { comments: '  ' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.event.findUnique).not.toHaveBeenCalled();
    });

    it('blocks request-revision from Draft', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(baseEvent({ status: 'Draft' }));
      await expect(
        service.requestRevision('evt-1', headUser, { comments: 'x' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('notification triggers', () => {
    it('notifies all Department Heads via role lookup on submit', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent())
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }));

      await service.submit('evt-1', ownerUser());

      expect(notifications.notifyRole).toHaveBeenCalledWith(
        'Department Head',
        {
          actorId: 'owner-1',
          type: 'EventSubmitted',
          eventId: 'evt-1',
          message: expect.stringContaining('Gala Night'),
        },
      );
    });

    it('notifies the event owner on approve', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Approved' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Planning' }));
      prisma.event.findFirst.mockResolvedValue(null);

      await service.approve('evt-1', headUser);

      expect(notifications.notify).toHaveBeenCalledWith({
        actorId: 'head-1',
        userIds: ['owner-1'],
        type: 'EventApproved',
        eventId: 'evt-1',
        message: expect.stringContaining('Gala Night'),
      });
    });

    it('notifies the event owner on reject', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Rejected' }));

      await service.reject('evt-1', headUser, { reason: 'Budget missing' });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'head-1',
          userIds: ['owner-1'],
          type: 'EventRejected',
          eventId: 'evt-1',
        }),
      );
    });

    it('notifies the event owner on requestRevision', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'RevisionRequired' }));

      await service.requestRevision('evt-1', headUser, {
        comments: 'Add sponsor list',
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'head-1',
          userIds: ['owner-1'],
          type: 'RevisionRequested',
          eventId: 'evt-1',
        }),
      );
    });

    it('passes actorId alongside owner so self-notification can be skipped', async () => {
      prisma.event.findUnique
        .mockResolvedValueOnce(baseEvent({ status: 'PendingApproval' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Approved' }))
        .mockResolvedValueOnce(baseEvent({ status: 'Planning' }));
      prisma.event.findFirst.mockResolvedValue(null);

      await service.approve('evt-1', ownerUser());

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'owner-1',
          userIds: ['owner-1'],
        }),
      );
    });
  });

  describe('history and pending queue', () => {
    it('returns approval history ordered ascending', async () => {
      prisma.event.findUnique.mockResolvedValueOnce({ id: 'evt-1' });
      const rows = [
        { id: 'a1', action: 'Submitted', createdAt: new Date('2026-09-10') },
      ];
      prisma.approval.findMany.mockResolvedValue(rows);

      await expect(service.findApprovalHistory('evt-1')).resolves.toEqual(rows);
      expect(prisma.approval.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'evt-1' },
          orderBy: { createdAt: 'asc' },
        }),
      );
    });

    it('history 404 for unknown event', async () => {
      prisma.event.findUnique.mockResolvedValueOnce(null);
      await expect(service.findApprovalHistory('missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('pending queue lists only PendingApproval events', async () => {
      prisma.event.findMany.mockResolvedValue([
        baseEvent({ status: 'PendingApproval' }),
      ]);

      await service.findPage();

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PendingApproval' },
        }),
      );
      expect(prisma.event.count).toHaveBeenCalledWith({
        where: { status: 'PendingApproval' },
      });
    });

    it('pending queue pages with limit/offset and reports total', async () => {
      const items = [baseEvent({ status: 'PendingApproval' })];
      prisma.event.findMany.mockResolvedValue(items);
      prisma.event.count.mockResolvedValue(57);

      await expect(service.findPage({ limit: 25, offset: 50 })).resolves.toEqual({
        items,
        total: 57,
      });
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'PendingApproval' },
          take: 25,
          skip: 50,
          include: expect.objectContaining({
            approvals: { orderBy: { createdAt: 'desc' }, take: 1 },
          }),
        }),
      );
    });

    it('pending queue defaults to page size 100', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPage();

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100, skip: 0 }),
      );
    });
  });
});

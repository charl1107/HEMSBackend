import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuditService } from './audit.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'log-1',
    userId: 'u1',
    method: 'POST',
    path: '/events/evt-1/approve',
    body: { action: 'approve' },
    statusCode: 200,
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    user: {
      id: 'u1',
      email: 'a@hems.local',
      firstName: 'Ada',
      lastName: 'Admin',
    },
    ...overrides,
  };
}

describe('AuditService.list', () => {
  let prisma: {
    auditLog: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };
  let service: AuditService;

  beforeEach(() => {
    prisma = {
      auditLog: {
        findMany: vi.fn().mockResolvedValue([makeRow()]),
        count: vi.fn().mockResolvedValue(1),
      },
    };
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('paginates with skip/take and returns page metadata', async () => {
    const result = await service.list({ page: 3, pageSize: 10 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
    expect(result).toMatchObject({ total: 1, page: 3, pageSize: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      entity: 'events',
      action: 'approve',
      method: 'POST',
      path: '/events/evt-1/approve',
    });
  });

  it('filters by userId', async () => {
    await service.list({ userId: 'u9', page: 1, pageSize: 20 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u9' } }),
    );
    expect(prisma.auditLog.count).toHaveBeenCalledWith({
      where: { userId: 'u9' },
    });
  });

  it('filters by entity path segment', async () => {
    await service.list({ entity: 'attendance', page: 1, pageSize: 20 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { path: '/attendance' },
            { path: { startsWith: '/attendance/' } },
            { path: { startsWith: '/attendance?' } },
          ],
        },
      }),
    );
  });

  it('filters by action as method or path suffix', async () => {
    await service.list({ action: 'approve', page: 1, pageSize: 20 });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ method: 'APPROVE' }, { path: { endsWith: '/approve' } }],
        },
      }),
    );
  });

  it('filters by date range', async () => {
    await service.list({
      dateFrom: '2026-09-01T00:00:00.000Z',
      dateTo: '2026-09-30T23:59:59.999Z',
      page: 1,
      pageSize: 20,
    });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: {
            gte: new Date('2026-09-01T00:00:00.000Z'),
            lte: new Date('2026-09-30T23:59:59.999Z'),
          },
        },
      }),
    );
  });

  it('combines userId, entity, and date filters with AND', async () => {
    await service.list({
      userId: 'u1',
      entity: 'events',
      dateFrom: '2026-09-01T00:00:00.000Z',
      page: 1,
      pageSize: 20,
    });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'u1',
          OR: [
            { path: '/events' },
            { path: { startsWith: '/events/' } },
            { path: { startsWith: '/events?' } },
          ],
          createdAt: { gte: new Date('2026-09-01T00:00:00.000Z') },
        },
      }),
    );
  });

  it('derives entity and action from path', async () => {
    prisma.auditLog.findMany.mockResolvedValue([
      makeRow({
        id: 'log-2',
        method: 'POST',
        path: '/attendance/sync',
        user: null,
        userId: null,
      }),
      makeRow({
        id: 'log-3',
        method: 'PATCH',
        path: '/events/8f14e45f-ceea-467f-a1d0-1234567890ab',
        body: { title: 'Renamed' },
      }),
    ]);
    prisma.auditLog.count.mockResolvedValue(2);

    const result = await service.list({ page: 1, pageSize: 20 });

    expect(result.items[0]).toMatchObject({
      entity: 'attendance',
      action: 'sync',
      user: null,
    });
    expect(result.items[1]).toMatchObject({
      entity: 'events',
      action: 'PATCH',
    });
  });
});

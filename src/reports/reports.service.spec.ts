import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ReportsService } from './reports.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

type MockPrisma = {
  event: { findMany: ReturnType<typeof vi.fn> };
  eventType: { findMany: ReturnType<typeof vi.fn> };
};

function makePrisma(): MockPrisma {
  return {
    event: { findMany: vi.fn().mockResolvedValue([]) },
    eventType: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

describe('ReportsService', () => {
  let prisma: MockPrisma;
  let service: ReportsService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new ReportsService(prisma as unknown as PrismaService);
  });

  describe('getSummary', () => {
    it('returns exactly the event statistics', async () => {
      prisma.event.findMany.mockResolvedValue([
        {
          status: 'Completed',
          eventTypeId: 'type-1',
          eventDate: new Date('2026-06-10T00:00:00.000Z'),
          campusScope: 'OnCampus',
        },
        {
          status: 'Planning',
          eventTypeId: 'type-1',
          eventDate: new Date('2026-06-21T00:00:00.000Z'),
          campusScope: 'OnCampus',
        },
        {
          status: 'Planning',
          eventTypeId: null,
          eventDate: new Date('2026-07-03T00:00:00.000Z'),
          campusScope: 'OffCampus',
        },
      ]);
      prisma.eventType.findMany.mockResolvedValue([
        { id: 'type-1', name: 'Fair' },
      ]);

      const summary = await service.getSummary();

      expect(summary).toEqual({
        events: {
          total: 3,
          byStatus: { Completed: 1, Planning: 2 },
          byType: { Fair: 2, Uncategorized: 1 },
          byMonth: { '2026-06': 2, '2026-07': 1 },
          byCampusScope: { OnCampus: 2, OffCampus: 1 },
        },
      });
      expect(summary).not.toHaveProperty('tasks');
      expect(summary.events.byMonth['2026-06']).toBe(2);
      expect(summary.events.byCampusScope.OnCampus).toBe(2);
    });

    it('keeps both campus scope keys at zero', async () => {
      prisma.event.findMany.mockResolvedValue([]);

      const summary = await service.getSummary();

      expect(summary).toEqual({
        events: {
          total: 0,
          byStatus: {},
          byType: {},
          byMonth: {},
          byCampusScope: { OnCampus: 0, OffCampus: 0 },
        },
      });
    });

    it('returns zeroed event statistics with no rows', async () => {
      const summary = await service.getSummary();

      expect(summary.events).toEqual({
        total: 0,
        byStatus: {},
        byType: {},
        byMonth: {},
        byCampusScope: { OnCampus: 0, OffCampus: 0 },
      });
      expect(summary).not.toHaveProperty('tasks');
    });
  });
});

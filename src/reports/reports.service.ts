import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface SummaryReport {
  events: {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byMonth: Record<string, number>;
    byCampusScope: Record<'OnCampus' | 'OffCampus', number>;
  };
  tasks: { total: number; done: number; completionRate: number };
}

function toRecord(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(): Promise<SummaryReport> {
    const [events, eventTypes, taskGroups] = await Promise.all([
      this.prisma.event.findMany({
        select: {
          status: true,
          eventTypeId: true,
          eventDate: true,
          campusScope: true,
        },
      }),
      this.prisma.eventType.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.eventTask.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const typeById = new Map(eventTypes.map((t) => [t.id, t.name]));
    const byStatus = new Map<string, number>();
    const byType = new Map<string, number>();
    const byMonth = new Map<string, number>();
    const byCampusScope: Record<'OnCampus' | 'OffCampus', number> = {
      OnCampus: 0,
      OffCampus: 0,
    };

    for (const event of events) {
      bump(byStatus, event.status);
      bump(
        byType,
        (event.eventTypeId ? typeById.get(event.eventTypeId) : null) ??
          'Uncategorized',
      );
      // UTC: @db.Date columns come back at UTC midnight, so slicing the ISO
      // string keeps byMonth stable regardless of the server timezone.
      bump(byMonth, event.eventDate.toISOString().slice(0, 7));
      byCampusScope[event.campusScope] += 1;
    }

    const totalTasks = taskGroups.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const doneTasks =
      taskGroups.find((row) => row.status === 'Done')?._count._all ?? 0;

    return {
      events: {
        total: events.length,
        byStatus: toRecord(byStatus),
        byType: toRecord(byType),
        byMonth: toRecord(byMonth),
        byCampusScope,
      },
      tasks: {
        total: totalTasks,
        done: doneTasks,
        completionRate:
          totalTasks === 0
            ? 0
            : Math.round((doneTasks / totalTasks) * 1000) / 10,
      },
    };
  }
}

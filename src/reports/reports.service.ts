import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { csvEscape, toCsv } from './csv.js';
import { ABSENTEE_DEFINITION } from './reports.constants.js';
import {
  buildEventReportPdf,
  type ReportPdfAbsentee,
  type ReportPdfInput,
} from './report-pdf.js';

export interface ExportFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface AttendanceRowStats {
  registered: number;
  present: number;
  absent: number;
  missing: number;
  absentees: number;
  presentRate: number;
  absentRate: number;
}

export interface EventReportParticipantRow {
  participantId: string;
  name: string;
  participantType: string;
  email: string | null;
  attendanceStatus: 'Present' | 'Absent' | null;
  timeIn: Date | null;
  timeOut: Date | null;
  isAbsentee: boolean;
  absenteeReason: string | null;
}

export interface EventReport {
  event: {
    id: string;
    title: string;
    status: string;
    eventDate: Date;
    venue: string;
    eventType: string | null;
    description: string | null;
  };
  participantTypes: { type: string; count: number }[];
  stats: AttendanceRowStats;
  participants: EventReportParticipantRow[];
  absentees: EventReportParticipantRow[];
  tasks: { total: number; done: number; completionRate: number };
  absenteeDefinition: string;
}

export interface SummaryReport {
  events: {
    total: number;
    completed: number;
    byStatus: { status: string; count: number }[];
    byType: { type: string; count: number }[];
  };
  participants: {
    total: number;
    byType: { type: string; count: number }[];
  };
  attendance: {
    present: number;
    absent: number;
    recorded: number;
    presentRate: number;
    absentRate: number;
    byEvent: {
      eventId: string;
      title: string;
      status: string;
      registered: number;
      present: number;
      absent: number;
      missing: number;
      presentRate: number;
      absentRate: number;
    }[];
  };
  tasks: { total: number; done: number; completionRate: number };
  absenteeDefinition: string;
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 10000) / 10000;
}

export function isAbsentee(
  eventStatus: string,
  attendanceStatus: 'Present' | 'Absent' | null,
): boolean {
  if (attendanceStatus === 'Absent') {
    return true;
  }
  return attendanceStatus === null && eventStatus === 'Completed';
}

function participantDisplayName(row: {
  externalName: string | null;
  user: { firstName: string; lastName: string; email: string } | null;
}): string {
  if (row.user) {
    return `${row.user.firstName} ${row.user.lastName}`.trim();
  }
  return row.externalName ?? 'Unknown';
}

function participantEmail(row: {
  externalName: string | null;
  user: { firstName: string; lastName: string; email: string } | null;
}): string | null {
  return row.user?.email ?? null;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event'
  );
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(): Promise<SummaryReport> {
    const [
      totalEvents,
      completedEvents,
      eventsByStatus,
      eventTypes,
      participantsByType,
      attendanceByStatus,
      taskGroups,
      events,
      registeredByEvent,
      attendanceByEvent,
    ] = await Promise.all([
      this.prisma.event.count(),
      this.prisma.event.count({ where: { status: 'Completed' } }),
      this.prisma.event.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.eventType.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.participant.groupBy({
        by: ['participantType'],
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.eventTask.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.event.findMany({
        select: {
          id: true,
          title: true,
          status: true,
          eventTypeId: true,
        },
        orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.participant.groupBy({
        by: ['eventId'],
        _count: { _all: true },
      }),
      this.prisma.attendance.groupBy({
        by: ['eventId', 'status'],
        _count: { _all: true },
      }),
    ]);

    const typeById = new Map(eventTypes.map((t) => [t.id, t.name]));
    const typeCounts = new Map<string, number>();
    for (const event of events) {
      const name =
        (event.eventTypeId ? typeById.get(event.eventTypeId) : null) ??
        'Uncategorized';
      typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
    }

    const registeredByEventId = new Map(
      registeredByEvent.map((row) => [row.eventId, row._count._all]),
    );
    const attendanceIndex = new Map<string, { Present: number; Absent: number }>();
    for (const row of attendanceByEvent) {
      const key = row.eventId;
      const entry = attendanceIndex.get(key) ?? { Present: 0, Absent: 0 };
      entry[row.status] = row._count._all;
      attendanceIndex.set(key, entry);
    }

    const byEvent = events.map((event) => {
      const registered = registeredByEventId.get(event.id) ?? 0;
      const attendance = attendanceIndex.get(event.id) ?? {
        Present: 0,
        Absent: 0,
      };
      const missing = Math.max(registered - attendance.Present - attendance.Absent, 0);
      const absentees =
        attendance.Absent +
        (event.status === 'Completed' ? missing : 0);
      return {
        eventId: event.id,
        title: event.title,
        status: event.status,
        registered,
        present: attendance.Present,
        absent: attendance.Absent,
        missing,
        presentRate: rate(attendance.Present, registered),
        absentRate: rate(absentees, registered),
      };
    });

    const present =
      attendanceByStatus.find((row) => row.status === 'Present')?._count._all ?? 0;
    const absent =
      attendanceByStatus.find((row) => row.status === 'Absent')?._count._all ?? 0;
    const totalParticipants = participantsByType.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const totalTasks = taskGroups.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const doneTasks =
      taskGroups.find((row) => row.status === 'Done')?._count._all ?? 0;

    return {
      events: {
        total: totalEvents,
        completed: completedEvents,
        byStatus: eventsByStatus
          .map((row) => ({ status: row.status, count: row._count._all }))
          .sort((a, b) => a.status.localeCompare(b.status)),
        byType: [...typeCounts.entries()]
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      },
      participants: {
        total: totalParticipants,
        byType: participantsByType
          .map((row) => ({
            type: row.participantType,
            count: row._count._all,
          }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      },
      attendance: {
        present,
        absent,
        recorded: present + absent,
        presentRate: rate(present, totalParticipants),
        absentRate: rate(absent, totalParticipants),
        byEvent,
      },
      tasks: {
        total: totalTasks,
        done: doneTasks,
        completionRate: rate(doneTasks, totalTasks),
      },
      absenteeDefinition: ABSENTEE_DEFINITION,
    };
  }

  async getEventReport(eventId: string): Promise<EventReport> {
    const event = await this.findEvent(eventId);
    const [participants, attendance, taskGroups] = await Promise.all([
      this.prisma.participant.findMany({
        where: { eventId },
        include: {
          user: {
            select: { firstName: true, lastName: true, email: true },
          },
          attendance: {
            where: { eventId },
            select: { status: true, timeIn: true, timeOut: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.attendance.findMany({
        where: { eventId },
        select: { status: true },
      }),
      this.prisma.eventTask.groupBy({
        by: ['status'],
        where: { eventId },
        _count: { _all: true },
      }),
    ]);

    const rows: EventReportParticipantRow[] = participants.map((row) => {
      const record = row.attendance[0] ?? null;
      const status = record?.status ?? null;
      const absentee = isAbsentee(event.status, status);
      let reason: string | null = null;
      if (absentee) {
        reason =
          status === 'Absent'
            ? 'Marked Absent'
            : 'No attendance record (event ended)';
      }
      return {
        participantId: row.id,
        name: participantDisplayName(row),
        participantType: row.participantType,
        email: participantEmail(row),
        attendanceStatus: status,
        timeIn: record?.timeIn ?? null,
        timeOut: record?.timeOut ?? null,
        isAbsentee: absentee,
        absenteeReason: reason,
      };
    });

    const present = attendance.filter((row) => row.status === 'Present').length;
    const absent = attendance.filter((row) => row.status === 'Absent').length;
    const registered = rows.length;
    const missing = Math.max(registered - present - absent, 0);
    const absentees = rows.filter((row) => row.isAbsentee);

    const typeCounts = new Map<string, number>();
    for (const row of rows) {
      typeCounts.set(
        row.participantType,
        (typeCounts.get(row.participantType) ?? 0) + 1,
      );
    }

    const totalTasks = taskGroups.reduce(
      (sum, row) => sum + row._count._all,
      0,
    );
    const doneTasks =
      taskGroups.find((row) => row.status === 'Done')?._count._all ?? 0;

    return {
      event: {
        id: event.id,
        title: event.title,
        status: event.status,
        eventDate: event.eventDate,
        venue: event.venue,
        eventType: event.eventType?.name ?? null,
        description: event.description,
      },
      participantTypes: [...typeCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => a.type.localeCompare(b.type)),
      stats: {
        registered,
        present,
        absent,
        missing,
        absentees: absentees.length,
        presentRate: rate(present, registered),
        absentRate: rate(absentees.length, registered),
      },
      participants: rows,
      absentees,
      tasks: {
        total: totalTasks,
        done: doneTasks,
        completionRate: rate(doneTasks, totalTasks),
      },
      absenteeDefinition: ABSENTEE_DEFINITION,
    };
  }

  async exportAttendanceCsv(eventId: string): Promise<ExportFile> {
    const report = await this.getEventReport(eventId);
    const headers = [
      'participantId',
      'name',
      'participantType',
      'email',
      'attendanceStatus',
      'timeIn',
      'timeOut',
      'isAbsentee',
      'absenteeReason',
    ];
    const rows = report.participants.map((row) => [
      row.participantId,
      row.name,
      row.participantType,
      row.email ?? '',
      row.attendanceStatus ?? 'No record',
      row.timeIn ?? '',
      row.timeOut ?? '',
      row.isAbsentee ? 'Yes' : 'No',
      row.absenteeReason ?? '',
    ]);
    return {
      buffer: Buffer.from(toCsv(headers, rows), 'utf8'),
      filename: `${slugify(report.event.title)}-attendance.csv`,
      mimeType: 'text/csv; charset=utf-8',
    };
  }

  async exportParticipantsCsv(eventId: string): Promise<ExportFile> {
    const report = await this.getEventReport(eventId);
    const headers = [
      'participantId',
      'name',
      'participantType',
      'email',
      'attendanceStatus',
      'isAbsentee',
      'absenteeReason',
    ];
    const rows = report.participants.map((row) => [
      row.participantId,
      row.name,
      row.participantType,
      row.email ?? '',
      row.attendanceStatus ?? 'No record',
      row.isAbsentee ? 'Yes' : 'No',
      row.absenteeReason ?? '',
    ]);
    const lines = [
      '',
      `Absentees: ${report.absentees.length}`,
      ...report.absentees.map((absentee) =>
        [
          absentee.participantId,
          absentee.name,
          absentee.participantType,
          absentee.email ?? '',
          '',
          'Yes',
          absentee.absenteeReason ?? '',
        ]
          .map(csvEscape)
          .join(','),
      ),
    ];
    const csv = `${toCsv(headers, rows)}${lines.join('\r\n')}\r\n`;
    return {
      buffer: Buffer.from(csv, 'utf8'),
      filename: `${slugify(report.event.title)}-participants.csv`,
      mimeType: 'text/csv; charset=utf-8',
    };
  }

  async exportEventPdf(eventId: string): Promise<ExportFile> {
    const report = await this.getEventReport(eventId);
    const input: ReportPdfInput = {
      event: report.event,
      stats: report.stats,
      participantTypes: report.participantTypes,
      absentees: report.absentees.map(
        (row): ReportPdfAbsentee => ({
          name: row.name,
          type: row.participantType,
          email: row.email,
          reason: row.absenteeReason ?? 'Absentee',
        }),
      ),
      tasks: report.tasks,
      absenteeDefinition: report.absenteeDefinition,
      generatedAt: new Date(),
    };
    const buffer = await buildEventReportPdf(input);
    return {
      buffer,
      filename: `${slugify(report.event.title)}-report.pdf`,
      mimeType: 'application/pdf',
    };
  }

  private async findEvent(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { eventType: { select: { name: true } } },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }
}

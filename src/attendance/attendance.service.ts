import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Attendance, EventType, Participant, User } from '@prisma/client';
import type { Event } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EVENT_INCLUDE } from '../events/events.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  ATTENDANCE_LATE_FIX_ROLE,
  ATTENDANCE_SUPERVISOR_ROLES,
} from '../events/events.constants.js';
import {
  SyncAttendanceDto,
  SyncAttendanceRecordDto,
  TimeAttendanceDto,
} from './dto/attendance.dto.js';

const ATTENDANCE_INCLUDE = {
  participant: {
    select: {
      id: true,
      externalName: true,
      participantType: true,
      user: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    },
  },
} as const;

export type AttendanceWithParticipant = Attendance & {
  participant: {
    id: string;
    externalName: string | null;
    participantType: string;
    user: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'> | null;
  };
};

export interface MyAttendanceRow {
  event: Event & { eventType: EventType | null };
  attendance: AttendanceWithParticipant;
}

export interface SyncRejection {
  clientRecordId: string;
  reason: string;
}

export interface SyncResult {
  accepted: string[];
  rejected: SyncRejection[];
}

type Tx = Pick<PrismaService, 'attendance' | 'auditLog'>;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findMany(eventId: string): Promise<AttendanceWithParticipant[]> {
    await this.findEvent(eventId);
    return this.prisma.attendance.findMany({
      where: { eventId },
      include: ATTENDANCE_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  async findMine(user: AuthUser): Promise<MyAttendanceRow[]> {
    const rows = await this.prisma.attendance.findMany({
      where: { participant: { userId: user.userId } },
      include: {
        ...ATTENDANCE_INCLUDE,
        event: { include: EVENT_INCLUDE },
      },
      orderBy: [{ event: { eventDate: 'desc' } }, { createdAt: 'desc' }],
    });
    return rows.map(({ event, ...attendance }) => ({ event, attendance }));
  }

  async timeIn(
    eventId: string,
    auth: AuthUser,
    dto: TimeAttendanceDto,
  ): Promise<AttendanceWithParticipant> {
    this.assertSupervisor(auth);
    const event = await this.findEvent(eventId);
    this.assertEventGate(event, auth);
    await this.assertParticipantInEvent(eventId, dto.participantId);
    const existing = await this.prisma.attendance.findFirst({
      where: { eventId, participantId: dto.participantId },
    });
    if (existing) {
      if (existing.timeIn && existing.status === 'Present') {
        return this.withParticipant(existing);
      }
      return this.prisma.attendance.update({
        where: { id: existing.id },
        data: {
          status: 'Present',
          timeIn: existing.timeIn ?? new Date(),
        },
        include: ATTENDANCE_INCLUDE,
      });
    }
    return this.prisma.attendance.create({
      data: {
        eventId,
        participantId: dto.participantId,
        status: 'Present',
        timeIn: new Date(),
      },
      include: ATTENDANCE_INCLUDE,
    });
  }

  async timeOut(
    eventId: string,
    auth: AuthUser,
    dto: TimeAttendanceDto,
  ): Promise<AttendanceWithParticipant> {
    this.assertSupervisor(auth);
    const event = await this.findEvent(eventId);
    this.assertEventGate(event, auth);
    await this.assertParticipantInEvent(eventId, dto.participantId);
    const existing = await this.prisma.attendance.findFirst({
      where: { eventId, participantId: dto.participantId },
    });
    if (!existing || !existing.timeIn) {
      throw new ConflictException(
        'Time-in is required before time-out for this participant',
      );
    }
    if (existing.timeOut) {
      return this.withParticipant(existing);
    }
    const now = new Date();
    if (now.getTime() < existing.timeIn.getTime()) {
      throw new BadRequestException('time-out cannot be before time-in');
    }
    return this.prisma.attendance.update({
      where: { id: existing.id },
      data: { timeOut: now },
      include: ATTENDANCE_INCLUDE,
    });
  }

  async sync(auth: AuthUser, dto: SyncAttendanceDto): Promise<SyncResult> {
    this.assertSupervisor(auth);
    const accepted: string[] = [];
    const rejected: SyncRejection[] = [];
    const events = new Map<string, Pick<Event, 'id' | 'status'> | null>();

    for (const record of dto.records) {
      let event = events.get(record.eventId);
      if (event === undefined) {
        event = await this.findEventOrNull(record.eventId);
        events.set(record.eventId, event);
      }
      if (!event) {
        rejected.push({
          clientRecordId: record.clientRecordId,
          reason: 'Event not found',
        });
        continue;
      }
      const gate = this.evaluateEventGate(event, auth);
      if (gate) {
        rejected.push({
          clientRecordId: record.clientRecordId,
          reason: gate,
        });
        continue;
      }
      const participant = await this.prisma.participant.findFirst({
        where: { id: record.participantId, eventId: record.eventId },
        select: { id: true },
      });
      if (!participant) {
        rejected.push({
          clientRecordId: record.clientRecordId,
          reason: 'Participant not found for this event',
        });
        continue;
      }
      const timeError = this.validateRecordTimes(record);
      if (timeError) {
        rejected.push({
          clientRecordId: record.clientRecordId,
          reason: timeError,
        });
        continue;
      }
      try {
        await this.prisma.$transaction(async (tx) => {
          await this.upsertRecord(tx, record);
          await this.audit.logWith(tx, {
            userId: auth.userId,
            method: 'POST',
            path: '/attendance/sync',
            body: {
              action: 'attendance.sync',
              clientRecordId: record.clientRecordId,
              eventId: record.eventId,
              participantId: record.participantId,
              status: record.status,
              timeIn: record.timeIn ?? null,
              timeOut: record.timeOut ?? null,
              deviceId: record.deviceId,
              recordedAt: record.recordedAt,
            },
            statusCode: 200,
          });
        });
        accepted.push(record.clientRecordId);
      } catch (error) {
        rejected.push({
          clientRecordId: record.clientRecordId,
          reason: this.errorMessage(error),
        });
      }
    }

    return { accepted, rejected };
  }

  private async upsertRecord(
    tx: Tx,
    record: SyncAttendanceRecordDto,
  ): Promise<Attendance> {
    const data = {
      status: record.status,
      timeIn: record.timeIn ? new Date(record.timeIn) : null,
      timeOut: record.timeOut ? new Date(record.timeOut) : null,
      syncedAt: new Date(),
    };
    const existingByClient = await tx.attendance.findUnique({
      where: { clientRecordId: record.clientRecordId },
    });
    if (existingByClient) {
      if (
        existingByClient.eventId !== record.eventId ||
        existingByClient.participantId !== record.participantId
      ) {
        throw new ConflictException(
          'clientRecordId already used for a different attendance record',
        );
      }
      return tx.attendance.update({
        where: { id: existingByClient.id },
        data,
      });
    }
    const existingByParticipant = await tx.attendance.findFirst({
      where: {
        eventId: record.eventId,
        participantId: record.participantId,
      },
    });
    if (existingByParticipant) {
      return tx.attendance.update({
        where: { id: existingByParticipant.id },
        data: { ...data, clientRecordId: record.clientRecordId },
      });
    }
    try {
      return await tx.attendance.create({
        data: {
          eventId: record.eventId,
          participantId: record.participantId,
          clientRecordId: record.clientRecordId,
          ...data,
        },
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      const racedByClient = await tx.attendance.findUnique({
        where: { clientRecordId: record.clientRecordId },
      });
      if (racedByClient) {
        return tx.attendance.update({
          where: { id: racedByClient.id },
          data,
        });
      }
      const racedByParticipant = await tx.attendance.findFirst({
        where: {
          eventId: record.eventId,
          participantId: record.participantId,
        },
      });
      if (racedByParticipant) {
        return tx.attendance.update({
          where: { id: racedByParticipant.id },
          data: { ...data, clientRecordId: record.clientRecordId },
        });
      }
      throw error;
    }
  }

  private assertSupervisor(auth: AuthUser): void {
    if (!ATTENDANCE_SUPERVISOR_ROLES.some((role) => auth.roles.includes(role))) {
      throw new ForbiddenException(
        'Only attendance supervisors can record or sync attendance',
      );
    }
  }

  private assertEventGate(
    event: Pick<Event, 'id' | 'status'>,
    auth: AuthUser,
  ): void {
    const reason = this.evaluateEventGate(event, auth);
    if (reason) {
      throw new ConflictException(reason);
    }
  }

  private evaluateEventGate(
    event: Pick<Event, 'id' | 'status'>,
    auth: AuthUser,
  ): string | null {
    if (event.status === 'Ongoing') {
      return null;
    }
    if (auth.roles.includes(ATTENDANCE_LATE_FIX_ROLE)) {
      return null;
    }
    return `Attendance requires event status Ongoing (current: ${event.status}); late-fix requires ${ATTENDANCE_LATE_FIX_ROLE}`;
  }

  private validateRecordTimes(record: SyncAttendanceRecordDto): string | null {
    if (!record.timeIn || !record.timeOut) {
      return null;
    }
    const timeIn = new Date(record.timeIn).getTime();
    const timeOut = new Date(record.timeOut).getTime();
    if (!(timeOut >= timeIn)) {
      return 'timeOut must be after or equal to timeIn';
    }
    return null;
  }

  private async findEvent(id: string): Promise<Pick<Event, 'id' | 'status'>> {
    const event = await this.findEventOrNull(id);
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }

  private async findEventOrNull(
    id: string,
  ): Promise<Pick<Event, 'id' | 'status'> | null> {
    return this.prisma.event.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
  }

  private async assertParticipantInEvent(
    eventId: string,
    participantId: string,
  ): Promise<Participant> {
    const participant = await this.prisma.participant.findFirst({
      where: { id: participantId, eventId },
    });
    if (!participant) {
      throw new NotFoundException('Participant not found for this event');
    }
    return participant;
  }

  private async withParticipant(
    attendance: Attendance,
  ): Promise<AttendanceWithParticipant> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: attendance.participantId },
      select: {
        id: true,
        externalName: true,
        participantType: true,
        user: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
    if (!participant) {
      throw new NotFoundException('Participant not found for this event');
    }
    return { ...attendance, participant };
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof ConflictException || error instanceof BadRequestException) {
      return error.message;
    }
    return error instanceof Error ? error.message : 'Failed to sync record';
  }
}

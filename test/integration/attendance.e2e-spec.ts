/**
 * HTTP integration tests for attendance (online capture + offline sync)
 * through the real app stack (global JWT guard + roles guard + throttler +
 * validation pipe + audit interceptor) with the database mocked. No
 * Postgres connection is opened.
 *
 * Reference: `ATTENDANCE_SUPERVISOR_ROLES` = Event Coordinator, Instructor,
 * Student Officer, Admin, Department Head. Capture requires the event to be
 * Ongoing (reachable through `POST /events/:id/advance`); once the event is no
 * longer Ongoing only `ATTENDANCE_LATE_FIX_ROLES` (= Event Coordinator, Admin,
 * Department Head) may record, everything else is 409.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ACTORS,
  createTestApp,
  userRowFor,
  type ActorName,
  type TestApp,
} from '../support/harness.js';

const EVENT_ID = 'ev-attendance';
const PARTICIPANT_ID = 'pt-1';
const ATTENDANCE_URL = `/events/${EVENT_ID}/attendance`;
const TIME_IN_URL = `${ATTENDANCE_URL}/time-in`;
const TIME_OUT_URL = `${ATTENDANCE_URL}/time-out`;
const SYNC_URL = '/attendance/sync';
const ME_URL = '/attendance/me';

/** Late-fix roles, in the order `AttendanceService.evaluateEventGate` joins them. */
const LATE_FIX_ROLES = 'Event Coordinator, Admin, Department Head';

/** Exact wording of `AttendanceService.evaluateEventGate`. */
const GATE = (current: string) =>
  `Attendance requires event status Ongoing (current: ${current}); late-fix requires ${LATE_FIX_ROLES}`;

async function bearerFor(ctx: TestApp, name: ActorName): Promise<string> {
  ctx.prisma.on('user.findUnique', userRowFor(name));
  return ctx.bearer({ sub: ACTORS[name].sub, email: ACTORS[name].email });
}

function scriptEvent(ctx: TestApp, status = 'Ongoing'): void {
  const row = { id: EVENT_ID, status };
  // Id-aware: any other event id must still resolve to null (404).
  ctx.prisma.on(
    'event.findUnique',
    (args: any) => (args?.where?.id === EVENT_ID ? row : null),
  );
}

function scriptParticipant(ctx: TestApp): void {
  ctx.prisma.on('participant.findFirst', {
    id: PARTICIPANT_ID,
    eventId: EVENT_ID,
  });
}

/**
 * One-row in-memory event so a lifecycle can be walked over real HTTP:
 * `GET`/reads return the current row, the advance endpoint's optimistic
 * `event.updateMany` write lands on it (mirrors events.e2e-spec helpers).
 */
function primeLifecycle(ctx: TestApp, status: string): { row: any } {
  const row = {
    id: EVENT_ID,
    title: 'Career Fair',
    status,
    createdById: ACTORS.coordinator.sub,
  };
  ctx.prisma.on('event.findUnique', () => row);
  ctx.prisma.on('event.updateMany', (args: any) => {
    if (args.where.status !== row.status) {
      return { count: 0 };
    }
    Object.assign(row, args.data);
    return { count: 1 };
  });
  return { row };
}

function syncRecord(overrides: Record<string, unknown> = {}) {
  return {
    clientRecordId: 'c-1',
    eventId: EVENT_ID,
    participantId: PARTICIPANT_ID,
    status: 'Present',
    timeIn: '2026-05-01T09:00:00.000Z',
    timeOut: '2026-05-01T11:00:00.000Z',
    deviceId: 'device-1',
    recordedAt: '2026-05-01T11:00:05.000Z',
    ...overrides,
  };
}

describe('attendance capture and offline sync (mocked database)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.prisma.reset();
  });

  it('rejects every attendance route without a token with 401 before any query runs', async () => {
    const server = ctx.app.getHttpServer();
    const routes: Array<[string, string]> = [
      ['get', ATTENDANCE_URL],
      ['post', TIME_IN_URL],
      ['post', TIME_OUT_URL],
      ['get', ME_URL],
      ['post', SYNC_URL],
    ];

    for (const [method, path] of routes) {
      const res = await (request(server) as any)[method](path).send({});
      const label = `${method.toUpperCase()} ${path}`;
      expect(res.status, label).toBe(401);
      expect(res.body.statusCode, label).toBe(401);
      expect(res.body.message, label).toMatch(/unauthorized/i);
    }

    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('blocks a Student at the roles guard (403) on every supervisor route', async () => {
    const bearer = await bearerFor(ctx, 'student');
    const server = ctx.app.getHttpServer();
    const routes: Array<[string, string, Record<string, unknown>]> = [
      ['get', ATTENDANCE_URL, {}],
      ['post', TIME_IN_URL, { participantId: PARTICIPANT_ID }],
      ['post', SYNC_URL, { records: [syncRecord()] }],
    ];

    for (const [method, path, body] of routes) {
      const res = await (request(server) as any)[method](path)
        .set('Authorization', bearer)
        .send(body);
      const label = `${method.toUpperCase()} ${path}`;
      expect(res.status, label).toBe(403);
      expect(res.body.statusCode, label).toBe(403);
    }

    expect(ctx.prisma.has('event.findUnique')).toBe(false);
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('captures attendance online (201) and writes the Present record', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
    });
    expect(typeof res.body.timeIn).toBe('string');

    const write = ctx.prisma.callsFor('attendance.create')[0];
    expect(write.data).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
    });
    expect(write.data.timeIn).toBeInstanceOf(Date);
  });

  it('FT-23: the owner advances Planning→Ongoing, then a Department Head times in (201)', async () => {
    const state = primeLifecycle(ctx, 'Planning');
    scriptParticipant(ctx);

    const ownerBearer = await bearerFor(ctx, 'coordinator');
    const advanced = await request(ctx.app.getHttpServer())
      .post(`/events/${EVENT_ID}/advance`)
      .set('Authorization', ownerBearer)
      .send({ to: 'Ongoing' })
      .expect(200);
    expect(advanced.body).toMatchObject({ id: EVENT_ID, status: 'Ongoing' });
    expect(state.row.status).toBe('Ongoing');

    const headBearer = await bearerFor(ctx, 'head');
    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', headBearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
    });
    expect(ctx.prisma.has('attendance.create')).toBe(true);
  });

  it('blocks a non-supervisor caller on an Ongoing event at the roles guard (403)', async () => {
    const state = primeLifecycle(ctx, 'Planning');

    const ownerBearer = await bearerFor(ctx, 'coordinator');
    await request(ctx.app.getHttpServer())
      .post(`/events/${EVENT_ID}/advance`)
      .set('Authorization', ownerBearer)
      .send({ to: 'Ongoing' })
      .expect(200);
    expect(state.row.status).toBe('Ongoing');

    const studentBearer = await bearerFor(ctx, 'student');
    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', studentBearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(ctx.prisma.has('participant.findFirst')).toBe(false);
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('returns the existing Present row on a repeated time-in instead of writing twice', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    ctx.prisma.on('attendance.findFirst', {
      id: 'att-1',
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
      timeIn: new Date('2026-05-01T09:00:00.000Z'),
      timeOut: null,
    });
    ctx.prisma.on('participant.findUnique', {
      id: PARTICIPANT_ID,
      eventId: EVENT_ID,
      externalName: null,
      participantType: 'Student',
      user: null,
    });
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({
      id: 'att-1',
      status: 'Present',
      participant: { id: PARTICIPANT_ID },
    });
    expect(ctx.prisma.has('attendance.create')).toBe(false);
    expect(ctx.prisma.has('attendance.update')).toBe(false);
  });

  it('refuses a late fix by an Instructor after the event is no longer Ongoing (409) before any lookup', async () => {
    scriptEvent(ctx, 'Completed');
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(409);

    expect(res.body.message).toBe(GATE('Completed'));
    expect(ctx.prisma.has('participant.findFirst')).toBe(false);
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('refuses a late fix by a Student Officer after the event is no longer Ongoing (409)', async () => {
    scriptEvent(ctx, 'Completed');
    const bearer = await bearerFor(ctx, 'officer');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(409);

    expect(res.body.message).toBe(GATE('Completed'));
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('allows the late fix for an Event Coordinator after the event is no longer Ongoing (201)', async () => {
    scriptEvent(ctx, 'Completed');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
    });
    expect(ctx.prisma.has('attendance.create')).toBe(true);
  });

  it('allows a Department Head to time in after the event is Completed (201, widened late fix)', async () => {
    scriptEvent(ctx, 'Completed');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'head');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
    });
    expect(ctx.prisma.has('attendance.create')).toBe(true);
  });

  it('allows a Student Officer to capture attendance while the event is Ongoing (201)', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'officer');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body.status).toBe('Present');
    expect(ctx.prisma.has('attendance.create')).toBe(true);
  });

  it('returns 404 Event not found for an unknown event id', async () => {
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(404);

    expect(res.body.message).toBe('Event not found');
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('returns 404 Participant not found for this event for an unknown participant', async () => {
    scriptEvent(ctx, 'Ongoing');
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({ participantId: 'pt-ghost' })
      .expect(404);

    expect(res.body.message).toBe('Participant not found for this event');
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('rejects time-out when no time-in exists (409) with the exact message', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_OUT_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(409);

    expect(res.body.message).toBe(
      'Time-in is required before time-out for this participant',
    );
    expect(ctx.prisma.has('attendance.update')).toBe(false);
  });

  it('records a time-out (201) after a time-in', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    ctx.prisma.on('attendance.findFirst', {
      id: 'att-1',
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      status: 'Present',
      timeIn: new Date('2026-05-01T09:00:00.000Z'),
      timeOut: null,
    });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_OUT_URL)
      .set('Authorization', bearer)
      .send({ participantId: PARTICIPANT_ID })
      .expect(201);

    expect(res.body).toMatchObject({ id: 'att-1' });
    expect(typeof res.body.timeOut).toBe('string');
    const write = ctx.prisma.callsFor('attendance.update')[0];
    expect(write.where).toMatchObject({ id: 'att-1' });
    expect(write.data.timeOut).toBeInstanceOf(Date);
  });

  it('rejects an empty time-in body at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TIME_IN_URL)
      .set('Authorization', bearer)
      .send({})
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('participantId');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('returns an empty attendance history for a Student on /attendance/me (200)', async () => {
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .get(ME_URL)
      .set('Authorization', bearer)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('accepts an offline sync record (201) and writes the attendance row inside a transaction', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord()] })
      .expect(201);

    expect(res.body).toEqual({ accepted: ['c-1'], rejected: [] });
    const write = ctx.prisma.callsFor('attendance.create')[0];
    expect(write.data).toMatchObject({
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      clientRecordId: 'c-1',
      status: 'Present',
    });
    expect(write.data.syncedAt).toBeInstanceOf(Date);
    expect(ctx.prisma.callsFor('$transaction')).toHaveLength(1);
  });

  it('does not write an already-synced clientRecordId twice (updates the existing row instead)', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    ctx.prisma.on('attendance.findUnique', {
      id: 'att-1',
      eventId: EVENT_ID,
      participantId: PARTICIPANT_ID,
      clientRecordId: 'c-1',
    });
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord()] })
      .expect(201);

    expect(res.body).toEqual({ accepted: ['c-1'], rejected: [] });
    expect(ctx.prisma.has('attendance.create')).toBe(false);
    const updates = ctx.prisma.callsFor('attendance.update');
    expect(updates).toHaveLength(1);
    expect(updates[0].where).toMatchObject({ id: 'att-1' });
    expect(updates[0].data).toMatchObject({ status: 'Present' });
    expect(updates[0].data.syncedAt).toBeInstanceOf(Date);
  });

  it('rejects a duplicate clientRecordId inside one batch: one row written, the second rejected (F11)', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord(), syncRecord({ status: 'Absent' })] })
      .expect(201);

    expect(res.body.accepted).toEqual(['c-1']);
    expect(res.body.rejected).toEqual([
      {
        clientRecordId: 'c-1',
        reason: 'duplicate clientRecordId in the same batch',
      },
    ]);
    expect(ctx.prisma.callsFor('attendance.create')).toHaveLength(1);
    expect(ctx.prisma.callsFor('attendance.update')).toHaveLength(0);
    expect(ctx.prisma.callsFor('$transaction')).toHaveLength(1);
  });

  it('reports a clientRecordId conflict as a rejected record without writing anything', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    // The id was already used for a different event.
    ctx.prisma.on('attendance.findUnique', {
      id: 'att-9',
      eventId: 'ev-someone-else',
      participantId: 'pt-someone-else',
      clientRecordId: 'c-1',
    });
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord()] })
      .expect(201);

    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected).toEqual([
      {
        clientRecordId: 'c-1',
        reason: 'clientRecordId already used for a different attendance record',
      },
    ]);
    expect(ctx.prisma.has('attendance.create')).toBe(false);
    expect(ctx.prisma.has('attendance.update')).toBe(false);
  });

  it('rejects a sync record whose event does not exist (200 with a rejection)', async () => {
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord({ eventId: 'ev-ghost' })] })
      .expect(201);

    expect(res.body).toEqual({
      accepted: [],
      rejected: [{ clientRecordId: 'c-1', reason: 'Event not found' }],
    });
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('rejects a sync record whose participant is not part of the event', async () => {
    scriptEvent(ctx, 'Ongoing');
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord({ participantId: 'pt-ghost' })] })
      .expect(201);

    expect(res.body).toEqual({
      accepted: [],
      rejected: [
        {
          clientRecordId: 'c-1',
          reason: 'Participant not found for this event',
        },
      ],
    });
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('applies the late-fix rule to offline sync too (Instructor + Completed event is rejected)', async () => {
    scriptEvent(ctx, 'Completed');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [syncRecord()] })
      .expect(201);

    expect(res.body.accepted).toEqual([]);
    expect(res.body.rejected).toEqual([
      { clientRecordId: 'c-1', reason: GATE('Completed') },
    ]);
    expect(ctx.prisma.has('$transaction')).toBe(false);
  });

  it('rejects a sync record whose timeOut precedes its timeIn', async () => {
    scriptEvent(ctx, 'Ongoing');
    scriptParticipant(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({
        records: [
          syncRecord({
            timeIn: '2026-05-01T12:00:00.000Z',
            timeOut: '2026-05-01T11:00:00.000Z',
          }),
        ],
      })
      .expect(201);

    expect(res.body).toEqual({
      accepted: [],
      rejected: [
        {
          clientRecordId: 'c-1',
          reason: 'timeOut must be after or equal to timeIn',
        },
      ],
    });
    expect(ctx.prisma.has('$transaction')).toBe(false);
    expect(ctx.prisma.has('attendance.create')).toBe(false);
  });

  it('rejects an empty or malformed sync batch at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'coordinator');
    const server = ctx.app.getHttpServer();

    const empty = await request(server)
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [] })
      .expect(400);
    expect(empty.body.statusCode).toBe(400);

    const malformed = await request(server)
      .post(SYNC_URL)
      .set('Authorization', bearer)
      .send({ records: [{ status: 'Present' }] })
      .expect(400);
    expect(malformed.body.statusCode).toBe(400);
    expect(JSON.stringify(malformed.body.message)).toContain('clientRecordId');

    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });
});

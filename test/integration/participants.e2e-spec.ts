/**
 * HTTP integration tests for the participants roster through the real app
 * stack (global JWT guard + roles guard + throttler + validation pipe +
 * audit interceptor) with the database mocked. No Postgres connection is
 * opened.
 *
 * RBAC reference: `ROSTER_MANAGER_ROLES` = Event Coordinator, Instructor,
 * Student Officer, Department Head, Admin; `STUDENT_SELF_REGISTER_ROLES` =
 * Student, Student Officer; `ROSTER_EVENT_STATUSES` = Approved, Planning,
 * Ongoing, Completed.
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

const EVENT_ID = 'ev-roster';
const ROSTER_URL = `/events/${EVENT_ID}/participants`;
const REGISTER_URL = `${ROSTER_URL}/register`;

/**
 * Scripts the row the JWT strategy resolves for `name`. Any other user id
 * resolves to `null` unless it is listed in `extraUsers`, so body lookups
 * such as `userId` behave like real database hits.
 */
async function bearerFor(
  ctx: TestApp,
  name: ActorName,
  extraUsers: Record<string, Record<string, unknown>> = {},
): Promise<string> {
  ctx.prisma.on('user.findUnique', (args: any) => {
    const id = args?.where?.id as string | undefined;
    if (id === ACTORS[name].sub) {
      return userRowFor(name);
    }
    return id === undefined ? null : (extraUsers[id] ?? null);
  });
  return ctx.bearer({ sub: ACTORS[name].sub, email: ACTORS[name].email });
}

function scriptEvent(
  ctx: TestApp,
  opts: { status?: string; createdById?: string } = {},
): void {
  ctx.prisma.on('event.findUnique', {
    id: EVENT_ID,
    status: opts.status ?? 'Approved',
    createdById: opts.createdById ?? ACTORS.coordinator.sub,
  });
}

describe('events/:eventId/participants (mocked database)', () => {
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

  it('rejects every roster route without a token with 401 before any query runs', async () => {
    const server = ctx.app.getHttpServer();
    const routes: Array<[string, string]> = [
      ['get', ROSTER_URL],
      ['post', ROSTER_URL],
      ['post', REGISTER_URL],
      ['delete', `${ROSTER_URL}/pt-1`],
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

  it('blocks a Student from reading the roster at the roles guard (403) without touching the service', async () => {
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .get(ROSTER_URL)
      .set('Authorization', bearer)
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toMatch(/forbidden/i);
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('lets a Student Officer read the roster (ROSTER_MANAGER_ROLES) and returns an empty list', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'officer');

    const res = await request(ctx.app.getHttpServer())
      .get(ROSTER_URL)
      .set('Authorization', bearer)
      .expect(200);

    expect(res.body).toEqual([]);
    expect(ctx.prisma.has('event.findUnique')).toBe(true);
  });

  it('returns 404 Event not found for an unknown event id', async () => {
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .get(ROSTER_URL)
      .set('Authorization', bearer)
      .expect(404);

    expect(res.body.message).toBe('Event not found');
  });

  it('lets every roster-manager role add a participant (201) and writes the row', async () => {
    scriptEvent(ctx);
    const managers: ActorName[] = [
      'coordinator',
      'instructor',
      'officer',
      'head',
      'admin',
    ];

    for (const name of managers) {
      const bearer = await bearerFor(ctx, name);
      const res = await request(ctx.app.getHttpServer())
        .post(ROSTER_URL)
        .set('Authorization', bearer)
        .send({ externalName: `Guest of ${name}` })
        .expect(201);

      expect(res.body, name).toMatchObject({
        eventId: EVENT_ID,
        externalName: `Guest of ${name}`,
        participantType: 'Guest',
        registrationStatus: 'Registered',
        userId: null,
      });
    }

    const writes = ctx.prisma.callsFor('participant.create');
    expect(writes).toHaveLength(managers.length);
    expect(writes[0]).toMatchObject({
      data: { eventId: EVENT_ID, participantType: 'Guest' },
    });
  });

  it('refuses a Student adding a participant with 403 from the service and writes nothing', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ externalName: 'Should not land' })
      .expect(403);

    expect(res.body.message).toBe(
      'Only the event owner or a roster-role user can manage participants',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('refuses roster management while the event is Draft (409) with the exact gate message', async () => {
    scriptEvent(ctx, { status: 'Draft' });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ externalName: 'Too early' })
      .expect(409);

    expect(res.body.message).toBe(
      'Participant operations require event status Approved, Planning, Ongoing, or Completed (current: Draft)',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('refuses a Student probing a Draft event they do not manage with 403 before the status gate (F9)', async () => {
    scriptEvent(ctx, { status: 'Draft', createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ externalName: 'Should not land' })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(
      'Only the event owner or a roster-role user can manage participants',
    );
    // F9: the 403 must not echo the event status the way the old 409 did.
    expect(JSON.stringify(res.body)).not.toContain('Draft');
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('still applies the Draft status gate (409) to a roster manager after the RBAC check (F9)', async () => {
    scriptEvent(ctx, { status: 'Draft', createdById: ACTORS.head.sub });
    const bearer = await bearerFor(ctx, 'head');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ externalName: 'Too early for a head' })
      .expect(409);

    expect(res.body.message).toBe(
      'Participant operations require event status Approved, Planning, Ongoing, or Completed (current: Draft)',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('rejects a body carrying both userId and externalName with 400 and writes nothing', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ userId: ACTORS.student.sub, externalName: 'Both given' })
      .expect(400);

    expect(res.body.message).toBe(
      'Provide exactly one of userId or externalName',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('rejects an invalid body at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ participantType: 'Robot' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('participantType');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('returns 404 User not found when adding an unknown userId', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'coordinator', {
      [ACTORS.student.sub]: userRowFor('student'),
    });

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ userId: 'ghost-user' })
      .expect(404);

    expect(res.body.message).toBe('User not found');
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('rejects a duplicate external name with 409', async () => {
    scriptEvent(ctx);
    ctx.prisma.on('participant.findFirst', {
      id: 'pt-1',
      eventId: EVENT_ID,
      externalName: 'Repeat Guest',
    });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(ROSTER_URL)
      .set('Authorization', bearer)
      .send({ externalName: 'repeat guest' })
      .expect(409);

    expect(res.body.message).toBe(
      'An external participant with this name already exists for this event',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('lets a Student self-register (201) and writes the student participant row', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(REGISTER_URL)
      .set('Authorization', bearer)
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      userId: ACTORS.student.sub,
      externalName: null,
      participantType: 'Student',
      registrationStatus: 'Registered',
    });
    expect(ctx.prisma.callsFor('participant.create')[0]).toMatchObject({
      data: {
        eventId: EVENT_ID,
        userId: ACTORS.student.sub,
        participantType: 'Student',
      },
    });
  });

  it('lets a Student Officer self-register (201)', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'officer');

    const res = await request(ctx.app.getHttpServer())
      .post(REGISTER_URL)
      .set('Authorization', bearer)
      .expect(201);

    expect(res.body).toMatchObject({
      userId: ACTORS.officer.sub,
      participantType: 'Student',
      registrationStatus: 'Registered',
    });
  });

  it('refuses self-registration for staff roles at the roles guard (403) before any query runs', async () => {
    scriptEvent(ctx);
    const staff: ActorName[] = ['coordinator', 'instructor', 'head', 'admin'];

    for (const name of staff) {
      const bearer = await bearerFor(ctx, name);
      const res = await request(ctx.app.getHttpServer())
        .post(REGISTER_URL)
        .set('Authorization', bearer)
        .expect(403);

      expect(res.body.statusCode, name).toBe(403);
      expect(res.body.message, name).toMatch(/forbidden/i);
    }

    // F6: the static `@Roles(...STUDENT_SELF_REGISTER_ROLES)` set now denies
    // staff before the service runs — no event lookup, no write. The
    // service-side `assertStudentRole` stays pinned by its unit test
    // ('forbids self-register for non-student roles').
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('refuses a duplicate self-registration with 409', async () => {
    scriptEvent(ctx);
    ctx.prisma.on('participant.findFirst', {
      id: 'pt-1',
      eventId: EVENT_ID,
      userId: ACTORS.student.sub,
    });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(REGISTER_URL)
      .set('Authorization', bearer)
      .expect(409);

    expect(res.body.message).toBe(
      'User is already a participant of this event',
    );
    expect(ctx.prisma.has('participant.create')).toBe(false);
  });

  it('refuses a Student deleting a participant with 403 from the service and deletes nothing', async () => {
    // F6 denial test: participants writes are owner/roster-role dynamic, so a
    // static @Roles would be wrong here — this pins the service-side check.
    scriptEvent(ctx);
    ctx.prisma.on('participant.findFirst', { id: 'pt-1', eventId: EVENT_ID });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${ROSTER_URL}/pt-1`)
      .set('Authorization', bearer)
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(
      'Only the event owner or a roster-role user can manage participants',
    );
    expect(ctx.prisma.has('participant.findFirst')).toBe(false);
    expect(ctx.prisma.has('participant.delete')).toBe(false);
  });

  it('removes a participant (200) and deletes exactly that row', async () => {
    scriptEvent(ctx);
    ctx.prisma.on('participant.findFirst', {
      id: 'pt-1',
      eventId: EVENT_ID,
    });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${ROSTER_URL}/pt-1`)
      .set('Authorization', bearer)
      .expect(200);

    expect(res.body).toEqual({});
    expect(ctx.prisma.callsFor('participant.delete')[0]).toMatchObject({
      where: { id: 'pt-1' },
    });
  });

  it('returns 404 Participant not found when removing an unknown participant', async () => {
    scriptEvent(ctx);
    ctx.prisma.on('participant.findFirst', null);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${ROSTER_URL}/pt-missing`)
      .set('Authorization', bearer)
      .expect(404);

    expect(res.body.message).toBe('Participant not found');
    expect(ctx.prisma.has('participant.delete')).toBe(false);
  });
});

/**
 * HTTP integration tests for committees through the real app stack
 * (global JWT guard + roles guard + throttler + validation pipe +
 * audit interceptor) with the database mocked. No Postgres connection is
 * opened.
 *
 * RBAC reference: `COMMITTEE_MANAGER_ROLES` = Admin, Department Head; the
 * service additionally allows the event owner (Event Coordinator, Instructor
 * and Student Officer therefore only manage committees they own). Committee
 * membership is never consulted for committee management.
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

const EVENT_ID = 'ev-committee';
const COMMITTEE_ID = 'cmte-1';
const BASE_URL = `/events/${EVENT_ID}/committees`;
const MEMBERS_URL = `${BASE_URL}/${COMMITTEE_ID}/members`;

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
  const row = {
    id: EVENT_ID,
    status: opts.status ?? 'Planning',
    createdById: opts.createdById ?? ACTORS.admin.sub,
  };
  // Id-aware: any other event id must still resolve to null (404).
  ctx.prisma.on(
    'event.findUnique',
    (args: any) => (args?.where?.id === EVENT_ID ? row : null),
  );
}

function scriptCommittee(ctx: TestApp): void {
  ctx.prisma.on('committee.findFirst', {
    id: COMMITTEE_ID,
    eventId: EVENT_ID,
    name: 'Core Committee',
  });
}

describe('events/:eventId/committees (mocked database)', () => {
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

  it('rejects every committee route without a token with 401 before any query runs', async () => {
    const server = ctx.app.getHttpServer();
    const routes: Array<[string, string]> = [
      ['get', BASE_URL],
      ['post', BASE_URL],
      ['post', MEMBERS_URL],
      ['delete', `${MEMBERS_URL}/${ACTORS.student.sub}`],
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

  it('lets Admin create a committee (201) and writes the committee row', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Core Committee', description: 'Runs the event' })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      name: 'Core Committee',
      description: 'Runs the event',
    });
    expect(ctx.prisma.callsFor('committee.create')[0]).toMatchObject({
      data: {
        eventId: EVENT_ID,
        name: 'Core Committee',
        description: 'Runs the event',
      },
    });
  });

  it('lets a Department Head create a committee (201)', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'head');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Logistics' })
      .expect(201);

    expect(res.body.name).toBe('Logistics');
    expect(ctx.prisma.has('committee.create')).toBe(true);
  });

  it('refuses a non-owner Event Coordinator with 403 and writes nothing', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Not mine' })
      .expect(403);

    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('lets an Event Coordinator who owns the event create a committee (201)', async () => {
    scriptEvent(ctx, { createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Owner run' })
      .expect(201);

    expect(res.body.name).toBe('Owner run');
    expect(ctx.prisma.has('committee.create')).toBe(true);
  });

  it('refuses a non-owner Instructor (403) but allows the Instructor who owns the event (201)', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    const bearer = await bearerFor(ctx, 'instructor');

    const refused = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Not mine either' })
      .expect(403);
    expect(refused.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );

    scriptEvent(ctx, { createdById: ACTORS.instructor.sub });
    const allowed = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Instructor run' })
      .expect(201);
    expect(allowed.body.name).toBe('Instructor run');

    expect(ctx.prisma.callsFor('committee.create')).toHaveLength(1);
  });

  it('refuses a non-owner Student Officer (403) but allows the Student Officer who owns the event (201)', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    const bearer = await bearerFor(ctx, 'officer');

    const refused = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Officer not owner' })
      .expect(403);
    expect(refused.body.statusCode).toBe(403);

    scriptEvent(ctx, { createdById: ACTORS.officer.sub });
    const allowed = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Officer owner' })
      .expect(201);
    expect(allowed.body.name).toBe('Officer owner');

    expect(ctx.prisma.callsFor('committee.create')).toHaveLength(1);
  });

  it('refuses a Student with 403', async () => {
    scriptEvent(ctx, { createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Students cannot' })
      .expect(403);

    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('does not let committee membership alone grant committee management', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    // The caller is a member of a committee of this event...
    ctx.prisma.on('committeeMember.findFirst', {
      id: 'member-1',
      committeeId: COMMITTEE_ID,
      userId: ACTORS.coordinator.sub,
    });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Member owned' })
      .expect(403);

    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    // ...but membership is never even consulted by the committees service.
    expect(ctx.prisma.has('committeeMember.findFirst')).toBe(false);
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('refuses committee management on a Cancelled event (409) even for Admin', async () => {
    scriptEvent(ctx, { status: 'Cancelled' });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Too late' })
      .expect(409);

    expect(res.body.message).toBe(
      'Committee operations require event status Planning, Ongoing, or Completed (current: Cancelled)',
    );
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('refuses a Student probing a Cancelled event they do not manage with 403 before the status gate (F9)', async () => {
    scriptEvent(ctx, { status: 'Cancelled', createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'Students cannot, and must not learn the status' })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    // F9: the 403 must not echo the event status the way the old 409 did.
    expect(JSON.stringify(res.body)).not.toContain('Cancelled');
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('returns 404 Event not found for an unknown event id', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'No event' })
      .expect(404);

    expect(res.body.message).toBe('Event not found');
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('rejects a duplicate committee name with 409', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: 'core committee' })
      .expect(409);

    expect(res.body.message).toBe(
      'A committee with this name already exists for this event',
    );
    expect(ctx.prisma.has('committee.create')).toBe(false);
  });

  it('rejects an invalid create body at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(BASE_URL)
      .set('Authorization', bearer)
      .send({ name: '' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('name');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('refuses a Student adding a committee member with 403 from the service and writes nothing', async () => {
    // F6 denial test: committee writes are owner/COMMITTEE_MANAGER_ROLES
    // dynamic, so no static @Roles — this pins the service-side check.
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({ userId: ACTORS.instructor.sub })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    expect(ctx.prisma.has('committeeMember.create')).toBe(false);
  });

  it('adds a committee member (201) and writes the membership row', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    ctx.prisma.on('committee.findUniqueOrThrow', {
      id: COMMITTEE_ID,
      eventId: EVENT_ID,
      name: 'Core Committee',
      members: [],
    });
    const bearer = await bearerFor(ctx, 'admin', {
      [ACTORS.student.sub]: userRowFor('student'),
    });

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({ userId: ACTORS.student.sub })
      .expect(201);

    expect(res.body).toMatchObject({ id: COMMITTEE_ID, members: [] });
    expect(ctx.prisma.callsFor('committeeMember.create')[0]).toMatchObject({
      data: { committeeId: COMMITTEE_ID, userId: ACTORS.student.sub },
    });
  });

  it('returns 404 User not found when adding an unknown user', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({ userId: 'ghost-user' })
      .expect(404);

    expect(res.body.message).toBe('User not found');
    expect(ctx.prisma.has('committeeMember.create')).toBe(false);
  });

  it('rejects a duplicate member with 409', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    ctx.prisma.on('committeeMember.findUnique', {
      committeeId: COMMITTEE_ID,
      userId: ACTORS.student.sub,
    });
    const bearer = await bearerFor(ctx, 'admin', {
      [ACTORS.student.sub]: userRowFor('student'),
    });

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({ userId: ACTORS.student.sub })
      .expect(409);

    expect(res.body.message).toBe(
      'User is already a member of this committee',
    );
    expect(ctx.prisma.has('committeeMember.create')).toBe(false);
  });

  it('returns 404 Committee not found for an unknown committee id', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin', {
      [ACTORS.student.sub]: userRowFor('student'),
    });

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({ userId: ACTORS.student.sub })
      .expect(404);

    expect(res.body.message).toBe('Committee not found');
    expect(ctx.prisma.has('committeeMember.create')).toBe(false);
  });

  it('rejects an invalid add-member body at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(MEMBERS_URL)
      .set('Authorization', bearer)
      .send({})
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('userId');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('refuses a Student removing a committee member with 403 from the service and deletes nothing', async () => {
    // F6 denial test: cross-role denial proving assertCanManageCommittees
    // holds on the DELETE member route (no static @Roles is possible here).
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${MEMBERS_URL}/${ACTORS.instructor.sub}`)
      .set('Authorization', bearer)
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(
      'Only the event owner, Admin, or Department Head can manage committees',
    );
    expect(ctx.prisma.has('committeeMember.findUnique')).toBe(false);
    expect(ctx.prisma.has('committeeMember.delete')).toBe(false);
  });

  it('removes a committee member (200) and deletes that membership', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    ctx.prisma.on('committeeMember.findUnique', {
      committeeId: COMMITTEE_ID,
      userId: ACTORS.student.sub,
    });
    const bearer = await bearerFor(ctx, 'head');

    await request(ctx.app.getHttpServer())
      .delete(`${MEMBERS_URL}/${ACTORS.student.sub}`)
      .set('Authorization', bearer)
      .expect(200);

    expect(ctx.prisma.callsFor('committeeMember.delete')[0]).toMatchObject({
      where: {
        committeeId_userId: {
          committeeId: COMMITTEE_ID,
          userId: ACTORS.student.sub,
        },
      },
    });
  });

  it('returns 404 Committee member not found when removing a non-member', async () => {
    scriptEvent(ctx);
    scriptCommittee(ctx);
    const bearer = await bearerFor(ctx, 'head');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${MEMBERS_URL}/${ACTORS.student.sub}`)
      .set('Authorization', bearer)
      .expect(404);

    expect(res.body.message).toBe('Committee member not found');
    expect(ctx.prisma.has('committeeMember.delete')).toBe(false);
  });

  it('reads committees for a known event (200) and 404s for an unknown one', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const found = await request(ctx.app.getHttpServer())
      .get(BASE_URL)
      .set('Authorization', bearer)
      .expect(200);
    expect(found.body).toEqual([]);

    const missing = await request(ctx.app.getHttpServer())
      .get('/events/ev-unknown/committees')
      .set('Authorization', bearer)
      .expect(404);
    expect(missing.body.message).toBe('Event not found');
  });

  it('Student can GET committees ⇒ 200', async () => {
    // F8 decision register: "document, don't gate". The committees read
    // surface stays open to every authenticated role (Students included);
    // only writes carry the owner/manager check (see capability matrix note).
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .get(BASE_URL)
      .set('Authorization', bearer)
      .expect(200);

    expect(res.body).toEqual([]);
    expect(ctx.prisma.has('event.findUnique')).toBe(true);
  });
});

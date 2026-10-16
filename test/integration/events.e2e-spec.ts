/**
 * HTTP integration tests for /events through the real app stack
 * (global JWT guard + roles guard + throttler + validation + audit interceptor)
 * with the database mocked. No Postgres connection is opened.
 *
 * Status codes below are what the product code actually does:
 *  - every `@Post` route without `@HttpCode` answers **201** on success
 *    (Nest's default), so "allowed" reads 201, not 200;
 *  - status transitions are written with
 *    `event.updateMany({ where: { id, status: from }, data: { status: to } })`
 *    (optimistic concurrency), not with `event.update`;
 *  - editing a non-editable event throws `ConflictException` => **409**.
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

const ACTOR_BY_ID = new Map<string, ActorName>(
  (Object.keys(ACTORS) as ActorName[]).map((name) => [ACTORS[name].sub, name]),
);

/** The JWT strategy resolves the caller from `user.findUnique` on every
 *  authenticated request; `reset()` in `beforeEach` clears it each time. */
function primeAuth(ctx: TestApp): void {
  ctx.prisma.on('user.findUnique', (args: any) => {
    const name = ACTOR_BY_ID.get(args?.where?.id);
    return name ? userRowFor(name) : null;
  });
}

function bearerFor(ctx: TestApp, actor: ActorName): Promise<string> {
  const { sub, email } = ACTORS[actor];
  return ctx.bearer({ sub, email });
}

function eventRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-1',
    title: 'Career Fair',
    description: 'Annual career fair',
    eventDate: new Date('2026-06-01T00:00:00.000Z'),
    venue: 'Main Hall',
    campusScope: 'OnCampus',
    status: 'Planning',
    coverImageUrl: null,
    eventTypeId: null,
    eventType: null,
    createdById: ACTORS.coordinator.sub,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

interface EventState {
  row: Record<string, unknown>;
}

/**
 * Turns `event` into a one-row in-memory table so a lifecycle can be walked
 * over real HTTP: reads return the current state, writes land on it.
 */
function primeEventState(
  ctx: TestApp,
  initial: Record<string, unknown> = eventRow(),
): EventState {
  const state: EventState = { row: initial };
  ctx.prisma.on('event.findUnique', () => state.row);
  ctx.prisma.on('event.update', (args: any) => {
    state.row = { ...state.row, ...args.data };
    return state.row;
  });
  ctx.prisma.on('event.updateMany', (args: any) => {
    state.row = { ...state.row, ...args.data };
    return { count: 1 };
  });
  return state;
}

describe('Events API (mocked database)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.prisma.reset();
    primeAuth(ctx);
  });

  describe('guard stack: anonymous callers get 401 on every protected route', () => {
    it('GET /events without a token => 401 and never queries events', async () => {
      await request(ctx.app.getHttpServer()).get('/events').expect(401);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('GET /events/:id without a token => 401', async () => {
      await request(ctx.app.getHttpServer()).get('/events/ev-1').expect(401);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
    });

    it('POST /events without a token => 401 and never creates an event', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events')
        .send({ title: 'Nope', eventDate: '2026-06-01', venue: 'Hall' })
        .expect(401);

      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('PUT /events/:id without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .send({ title: 'Nope' })
        .expect(401);

      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('DELETE /events/:id without a token => 401', async () => {
      await request(ctx.app.getHttpServer()).delete('/events/ev-1').expect(401);

      expect(ctx.prisma.has('event.delete')).toBe(false);
    });

    it('POST /events/:id/cover without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/cover')
        .expect(401);
    });

    it('DELETE /events/:id/cover without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .delete('/events/ev-1/cover')
        .expect(401);
    });
  });

  describe('creation is limited to the submit roles', () => {
    it('an Instructor creates a Planning event owned by themselves (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ title: 'Study session', eventDate: '2026-06-01', venue: 'B203' })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body.createdById).toBe(ACTORS.instructor.sub);
    });

    it('a Student is denied creation (403)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ title: 'Study session', eventDate: '2026-06-01', venue: 'B203' })
        .expect(403);

      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('a Department Head creates a Planning event (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ title: 'Department forum', eventDate: '2026-06-02', venue: 'A101' })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body.createdById).toBe(ACTORS.head.sub);
      expect(res.body.conflictWarning).toBeNull();

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Planning');
      expect(created.data.eventDate).toBeInstanceOf(Date);
      expect(created.data.campusScope).toBe('OnCampus');
    });

    it('an Event Coordinator creates a Planning event (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Hackathon', eventDate: '2026-06-03', venue: 'Lab 1' })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body.createdById).toBe(ACTORS.coordinator.sub);
    });

    it('a Student Officer creates a Planning event owned by themselves (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'officer'))
        .send({ title: 'Officers meetup', eventDate: '2026-06-04', venue: 'C1' })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body.createdById).toBe(ACTORS.officer.sub);
    });
  });

  describe('department never reaches the write path (removed field)', () => {
    it('POST /events with department => 201 and the whitelist strips it before Prisma', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({
          title: 'Dept-less fair',
          eventDate: '2026-06-14',
          venue: 'Quad',
          department: 'Computer Science',
        })
        .expect(201);

      expect(res.body).not.toHaveProperty('department');

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data).not.toHaveProperty('department');
    });

    it('PUT /events/:id with department => 200 and the value is stripped from the update', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Renamed', department: 'Student Affairs' })
        .expect(200);

      // The payload never reaches Prisma, and the stored row only got the title.
      expect(res.body).not.toHaveProperty('department');

      const update = ctx.prisma.callsFor('event.update')[0] as any;
      expect(update.data).not.toHaveProperty('department');
      expect(state.row.title).toBe('Renamed');
    });
  });

  describe('venue conflict is detected across events but never with itself (F29)', () => {
    it('a second create at the same venue+date reports a conflict naming the first event', async () => {
      // Model the table behind conflictWhere: rows matching venue + date,
      // minus the id the query excludes. The row just created is already in
      // the table when the probe runs, exactly like a real insert.
      const rows: Record<string, unknown>[] = [];
      ctx.prisma.on('event.create', (args: any) => {
        const row = eventRow({
          id: `ev-${rows.length + 1}`,
          title: args.data.title,
          venue: args.data.venue,
          eventDate: args.data.eventDate,
          status: args.data.status,
          createdById: args.data.createdById,
        });
        rows.push(row);
        return row;
      });
      ctx.prisma.on('event.findFirst', (args: any) => {
        const excludeId = args?.where?.id?.not;
        const venue = String(args?.where?.venue?.equals ?? '').toLowerCase();
        const eventDate = args?.where?.eventDate as Date;
        return (
          rows.find(
            (row) =>
              row.id !== excludeId &&
              String(row.venue).toLowerCase() === venue &&
              (row.eventDate as Date).toISOString() === eventDate.toISOString(),
          ) ?? null
        );
      });

      const payload = {
        eventDate: '2026-06-10',
        venue: 'Quad',
      };

      const first = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ ...payload, title: 'Spring Fair' })
        .expect(201);

      const second = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ ...payload, title: 'Alumni Meet' })
        .expect(201);

      // The first create must not warn about the row it just wrote (F29).
      expect(first.body.conflictWarning).toBeNull();
      // A real clash is still reported and names the existing event.
      expect(second.body.conflictWarning).toContain('Spring Fair');
      expect(second.body.conflictWarning).toMatch(/^Venue conflict:/);
    });
  });

  describe('update / delete are limited to the submit roles', () => {
    it('an Instructor who does not own the event is refused by the service (403)', async () => {
      primeEventState(ctx, eventRow({ createdById: ACTORS.coordinator.sub }));

      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ title: 'Renamed' })
        .expect(403);

      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('a Student cannot update an event (403, guard blocks before the service)', async () => {
      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ title: 'Renamed' })
        .expect(403);

      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('an Instructor cannot delete an event they do not own (403)', async () => {
      primeEventState(ctx, eventRow({ createdById: ACTORS.coordinator.sub }));

      await request(ctx.app.getHttpServer())
        .delete('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .expect(403);

      expect(ctx.prisma.has('event.delete')).toBe(false);
    });

    it('an Event Coordinator deletes a Planning event (200)', async () => {
      primeEventState(ctx, eventRow({ status: 'Planning' }));

      await request(ctx.app.getHttpServer())
        .delete('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .expect(200);

      expect(ctx.prisma.callsFor('event.delete')[0]).toEqual({ where: { id: 'ev-1' } });
    });
  });

  describe('GET /events visibility filter', () => {
    it('a Student only sees public statuses or events they created', async () => {
      primeEventState(ctx, eventRow());
      ctx.prisma.on('event.findMany', []);

      const res = await request(ctx.app.getHttpServer())
        .get('/events')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .expect(200);

      expect(res.body).toEqual({ items: [], total: 0 });

      const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
      expect(findMany.where.OR).toEqual([
        {
          status: {
            in: ['Planning', 'Ongoing', 'Completed'],
          },
        },
        { createdById: ACTORS.student.sub },
      ]);
    });

    it('an Admin is a reviewer and therefore gets no visibility filter', async () => {
      primeEventState(ctx, eventRow());
      ctx.prisma.on('event.findMany', []);

      await request(ctx.app.getHttpServer())
        .get('/events')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(200);

      const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
      expect(findMany.where).toEqual({});
    });
  });

  describe('event creation over HTTP', () => {
    it('creates a Planning event (201) with a null conflict warning', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({
          title: 'Spring Fair',
          description: 'Open-air fair',
          eventDate: '2026-06-10',
          venue: 'Quad',
          campusScope: 'OnCampus',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        title: 'Spring Fair',
        venue: 'Quad',
        campusScope: 'OnCampus',
        status: 'Planning',
        createdById: ACTORS.coordinator.sub,
        conflictWarning: null,
      });

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Planning');
      expect(created.data.createdById).toBe(ACTORS.coordinator.sub);
      expect(ctx.prisma.has('event.findFirst')).toBe(true); // conflict probe
    });
  });

  describe('lifecycle advance endpoint: Planning → Ongoing → Completed (F17)', () => {
    it('owner (Event Coordinator) advances Planning→Ongoing ⇒ 200, status persisted', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Ongoing' })
        .expect(200);

      expect(res.body).toMatchObject({ id: 'ev-1', status: 'Ongoing' });
      expect(state.row.status).toBe('Ongoing');

      const transitions = ctx.prisma.callsFor('event.updateMany') as any[];
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        where: { id: 'ev-1', status: 'Planning' },
        data: { status: 'Ongoing' },
      });
    });

    it('same user Ongoing→Completed ⇒ 200', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Ongoing' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Completed' })
        .expect(200);

      expect(res.body.status).toBe('Completed');
      expect(state.row.status).toBe('Completed');
      expect(ctx.prisma.callsFor('event.updateMany')[0]).toEqual({
        where: { id: 'ev-1', status: 'Ongoing' },
        data: { status: 'Completed' },
      });
    });

    it('non-owner Instructor ⇒ 403', async () => {
      const state = primeEventState(
        ctx,
        eventRow({ status: 'Planning', createdById: ACTORS.coordinator.sub }),
      );

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ to: 'Ongoing' })
        .expect(403);

      expect(res.body.message).toBe(
        'Only the event owner, an Admin or a Department Head can change event status',
      );
      expect(state.row.status).toBe('Planning');
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('Planning→Completed ⇒ 409 (canTransition false)', async () => {
      primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Completed' })
        .expect(409);

      expect(res.body.message).toBe(
        'Invalid event status transition Planning → Completed',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it("to: 'Rejected' ⇒ 400 (a removed status is not an EventStatus at all)", async () => {
      // The DTO validates `to` against the four lifecycle values, so a value
      // from the removed approval model fails validation before the service.
      primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Rejected' })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('to');
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('to: Cancelled is a legal transition (Planning→Cancelled ⇒ 200)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Cancelled' })
        .expect(200);

      expect(state.row.status).toBe('Cancelled');
    });

    it('a second advance with a stale copy ⇒ 409', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));
      // Simulates the concurrent change between read and write: the service
      // reads the Planning copy while another actor has already moved the row
      // to Ongoing before the write lands.
      ctx.prisma.on('event.findUnique', () => {
        const staleCopy = { ...state.row, status: 'Planning' };
        state.row = { ...state.row, status: 'Ongoing' };
        return staleCopy;
      });
      // updateMany matches only rows whose current status still equals the
      // where clause — the real optimistic-concurrency rule (as in Postgres).
      ctx.prisma.on('event.updateMany', (args: any) => {
        if (args.where.status !== state.row.status) {
          return { count: 0 };
        }
        state.row = { ...state.row, ...args.data };
        return { count: 1 };
      });

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Ongoing' })
        .expect(409);

      expect(res.body.message).toBe('event status changed');
      // The write named the CURRENT status in its where clause...
      expect(ctx.prisma.callsFor('event.updateMany')[0]).toEqual({
        where: { id: 'ev-1', status: 'Planning' },
        data: { status: 'Ongoing' },
      });
      // ...so it matched no row and the concurrent Ongoing wins untouched.
      expect(state.row.status).toBe('Ongoing');
    });
  });

  describe('editing is allowed only in Planning | Ongoing', () => {
    it('lets the owner edit a Planning event (200)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Career Fair 2026' })
        .expect(200);

      expect(res.body.title).toBe('Career Fair 2026');
      expect(state.row.title).toBe('Career Fair 2026');

      const update = ctx.prisma.callsFor('event.update')[0] as any;
      expect(update.where).toEqual({ id: 'ev-1' });
      expect(update.data).toEqual({ title: 'Career Fair 2026' });
    });

    it('allows editing an Ongoing event (200)', async () => {
      primeEventState(ctx, eventRow({ status: 'Ongoing' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ venue: 'Main Hall B' })
        .expect(200);

      expect(res.body.venue).toBe('Main Hall B');
    });

    it('refuses to edit a Completed event with 409 (ConflictException)', async () => {
      primeEventState(ctx, eventRow({ status: 'Completed' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Sneaky edit' })
        .expect(409);

      expect(res.body.message).toBe(
        'Event can only be edited while Planning or Ongoing (current: Completed)',
      );
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('refuses to edit a Cancelled event with 409', async () => {
      primeEventState(ctx, eventRow({ status: 'Cancelled' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Too late' })
        .expect(409);

      expect(res.body.message).toContain('current: Cancelled');
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('refuses an edit from a submit-role user who neither owns nor holds an edit role (403)', async () => {
      // Student Officer passes the @Roles gate (it is a submit role) but is
      // neither the owner nor a Department Head/Admin, so the service rejects it.
      primeEventState(ctx, eventRow({ createdById: ACTORS.coordinator.sub }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'officer'))
        .send({ title: 'Not yours' })
        .expect(403);

      expect(res.body.message).toBe(
        'Only a Department Head, an Admin or the event owner can edit this event',
      );
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('refuses an Event Coordinator editing an event they do not own (403)', async () => {
      // Coordinators are plain owners: the edit check is owner + Department
      // Head + Admin, not the review roles.
      primeEventState(ctx, eventRow({ createdById: ACTORS.head.sub }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Not mine either' })
        .expect(403);

      expect(res.body.message).toBe(
        'Only a Department Head, an Admin or the event owner can edit this event',
      );
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('PUT cannot change the status: the whitelist strips it', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Renamed', status: 'Ongoing' })
        .expect(200);

      expect(res.body.title).toBe('Renamed');
      expect(state.row.status).toBe('Planning');

      const update = ctx.prisma.callsFor('event.update')[0] as any;
      expect(update.data).toEqual({ title: 'Renamed' });
      expect(update.data).not.toHaveProperty('status');
    });
  });

  describe('not found', () => {
    it('GET /events/:id with an unknown id => 404', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/events/does-not-exist')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(404);

      expect(res.body.message).toBe('Event not found');
    });

    it('PUT /events/:id with an unknown id => 404', async () => {
      await request(ctx.app.getHttpServer())
        .put('/events/does-not-exist')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Nope' })
        .expect(404);

      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('DELETE /events/:id with an unknown id => 404', async () => {
      await request(ctx.app.getHttpServer())
        .delete('/events/does-not-exist')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(404);

      expect(ctx.prisma.has('event.delete')).toBe(false);
    });

    it('a Cancelled event a Student cannot see answers 404, not 403', async () => {
      primeEventState(
        ctx,
        eventRow({ status: 'Cancelled', createdById: ACTORS.coordinator.sub }),
      );

      const res = await request(ctx.app.getHttpServer())
        .get('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .expect(404);

      expect(res.body.message).toBe('Event not found');
    });
  });

  describe('validation short-circuits before the service', () => {
    it('a body missing the required title => 400 and no event.create', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ eventDate: '2026-06-01', venue: 'Hall' })
        .expect(400);

      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('a malformed eventDate => 400 and no event.create', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Bad date', eventDate: 'yesterday-ish', venue: 'Hall' })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('eventDate');
      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('PUT with a malformed eventDate => 400 and the service is never reached', async () => {
      primeEventState(ctx, eventRow());

      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ eventDate: '2026-99-99' })
        .expect(400);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('an unknown status filter on GET /events => 400 and no query is issued', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events?status=NotAStatus')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(400);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('an out-of-range limit on GET /events => 400 (this route does validate its query)', async () => {
      // Contrast with GET /public/events, which now imports the same DTO as a
      // value and validates identically (F16/F35 fixed by Task 1).
      await request(ctx.app.getHttpServer())
        .get('/events?limit=0')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(400);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('unknown properties are stripped by the whitelist and never persisted', async () => {
      // The ValidationPipe uses `whitelist: true` without
      // `forbidNonWhitelisted`, so an unknown property is dropped rather than
      // rejected: the body still validates, but the smuggled fields (here an
      // attempt to pre-approve the event) never reach Prisma.
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({
          title: 'Escalate me',
          eventDate: '2026-06-05',
          venue: 'Hall 2',
          status: 'Ongoing',
          isAdmin: true,
        })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body).not.toHaveProperty('isAdmin');

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Planning');
      expect(created.data).not.toHaveProperty('isAdmin');
    });
  });
});

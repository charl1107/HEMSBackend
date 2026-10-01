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
    department: 'Computer Science',
    campusScope: 'OnCampus',
    status: 'Draft',
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

    it('GET /events/:id/approval-history without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events/ev-1/approval-history')
        .expect(401);

      expect(ctx.prisma.has('approval.findMany')).toBe(false);
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

    it('POST /events/:id/submit without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .send({})
        .expect(401);

      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('POST /events/:id/approve without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .send({})
        .expect(401);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
    });

    it('POST /events/:id/reject without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .send({ reason: 'no' })
        .expect(401);
    });

    it('POST /events/:id/request-revision without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .send({ comments: 'fix it' })
        .expect(401);
    });
  });

  describe('creation is limited to the submit roles', () => {
    it('an Instructor is denied creation (403, guard blocks before the service)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ title: 'Study session', eventDate: '2026-06-01', venue: 'B203' })
        .expect(403);

      expect(res.body.message).toMatch(/forbidden/i);
      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('a Student is denied creation (403)', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ title: 'Study session', eventDate: '2026-06-01', venue: 'B203' })
        .expect(403);

      expect(ctx.prisma.has('event.create')).toBe(false);
    });

    it('a Department Head creates a Draft event (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ title: 'Department forum', eventDate: '2026-06-02', venue: 'A101' })
        .expect(201);

      expect(res.body.status).toBe('Draft');
      expect(res.body.createdById).toBe(ACTORS.head.sub);
      expect(res.body.conflictWarning).toBeNull();

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Draft');
      expect(created.data.eventDate).toBeInstanceOf(Date);
      expect(created.data.campusScope).toBe('OnCampus');
    });

    it('an Event Coordinator creates a Draft event (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Hackathon', eventDate: '2026-06-03', venue: 'Lab 1' })
        .expect(201);

      expect(res.body.status).toBe('Draft');
      expect(res.body.createdById).toBe(ACTORS.coordinator.sub);
    });

    it('a Student Officer creates a Draft event owned by themselves (201)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'officer'))
        .send({ title: 'Officers meetup', eventDate: '2026-06-04', venue: 'C1' })
        .expect(201);

      expect(res.body.status).toBe('Draft');
      expect(res.body.createdById).toBe(ACTORS.officer.sub);
    });
  });

  describe('blank department is treated as omitted (F27)', () => {
    it('POST /events with department: "" => 201 and the persisted department is null', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({
          title: 'Dept-less fair',
          eventDate: '2026-06-14',
          venue: 'Quad',
          department: '',
        })
        .expect(201);

      expect(res.body.department).toBeNull();

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.department).toBeNull();
    });

    it('PUT /events/:id with department: "" => 200 and the blank value is omitted from the update', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Renamed', department: '' })
        .expect(200);

      expect(res.body.department).toBe('Computer Science');

      const update = ctx.prisma.callsFor('event.update')[0] as any;
      expect(update.data).not.toHaveProperty('department');
      expect(state.row.department).toBe('Computer Science');
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
        department: 'Student Affairs',
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
    it('an Instructor cannot update an event (403) and the service never runs', async () => {
      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ title: 'Renamed' })
        .expect(403);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('a Student cannot update an event (403)', async () => {
      await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ title: 'Renamed' })
        .expect(403);

      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('an Instructor cannot delete an event (403)', async () => {
      await request(ctx.app.getHttpServer())
        .delete('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .expect(403);

      expect(ctx.prisma.has('event.delete')).toBe(false);
    });

    it('an Event Coordinator deletes a Draft event (200)', async () => {
      primeEventState(ctx, eventRow({ status: 'Draft' }));

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
            in: ['Approved', 'Planning', 'Ongoing', 'Completed'],
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

  describe('full lifecycle over HTTP: Draft -> PendingApproval -> Approved -> Planning', () => {
    it('creates a Draft event (201) with a null conflict warning', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({
          title: 'Spring Fair',
          description: 'Open-air fair',
          eventDate: '2026-06-10',
          venue: 'Quad',
          department: 'Student Affairs',
          campusScope: 'OnCampus',
        })
        .expect(201);

      expect(res.body).toMatchObject({
        title: 'Spring Fair',
        venue: 'Quad',
        campusScope: 'OnCampus',
        status: 'Draft',
        createdById: ACTORS.coordinator.sub,
        conflictWarning: null,
      });

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Draft');
      expect(created.data.createdById).toBe(ACTORS.coordinator.sub);
      expect(ctx.prisma.has('event.findFirst')).toBe(true); // conflict probe
    });

    it('submits a Draft for approval (201 PendingApproval)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ comments: 'ready for review' })
        .expect(201);

      expect(res.body.status).toBe('PendingApproval');
      expect(state.row.status).toBe('PendingApproval');

      const transitions = ctx.prisma.callsFor('event.updateMany') as any[];
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toEqual({
        where: { id: 'ev-1', status: 'Draft' },
        data: { status: 'PendingApproval' },
      });

      const approval = ctx.prisma.callsFor('approval.create')[0] as any;
      expect(approval.data).toMatchObject({
        eventId: 'ev-1',
        reviewerId: ACTORS.coordinator.sub,
        action: 'Submitted',
        comments: 'ready for review',
      });
    });

    it('approves a pending event and lands it in Planning (201)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ comments: 'looks good' })
        .expect(201);

      // The API performs Approved and then Planning in one call.
      expect(res.body.status).toBe('Planning');
      expect(state.row.status).toBe('Planning');
      expect(res.body.conflictWarning).toBeNull();

      const transitions = ctx.prisma.callsFor('event.updateMany') as any[];
      expect(transitions).toHaveLength(2);
      expect(transitions[0]).toEqual({
        where: { id: 'ev-1', status: 'PendingApproval' },
        data: { status: 'Approved' },
      });
      expect(transitions[1]).toEqual({
        where: { id: 'ev-1', status: 'Approved' },
        data: { status: 'Planning' },
      });

      const approval = ctx.prisma.callsFor('approval.create')[0] as any;
      expect(approval.data).toMatchObject({
        action: 'Approved',
        reviewerId: ACTORS.head.sub,
        comments: 'looks good',
      });
    });

    it('refuses to approve a Draft with 409 and writes nothing', async () => {
      primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({})
        .expect(409);

      expect(res.body.message).toBe(
        'Invalid event status transition Draft → Approved',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
      expect(ctx.prisma.has('approval.create')).toBe(false);
    });

    it('refuses to advance a Planning event via approve: Planning → Approved is not a valid transition', async () => {
      // Planning -> Ongoing -> Completed moves via POST /events/:id/advance (F17);
      // approve alone cannot jump a Planning event straight to Approved.
      primeEventState(ctx, eventRow({ status: 'Planning' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({})
        .expect(409);

      expect(res.body.message).toBe(
        'Invalid event status transition Planning → Approved',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('rejects a pending event with a reason (201 Rejected)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ reason: 'budget not approved' })
        .expect(201);

      expect(res.body.status).toBe('Rejected');
      expect(state.row.status).toBe('Rejected');

      const transitions = ctx.prisma.callsFor('event.updateMany') as any[];
      expect(transitions[0]).toEqual({
        where: { id: 'ev-1', status: 'PendingApproval' },
        data: { status: 'Rejected' },
      });
      expect((ctx.prisma.callsFor('approval.create')[0] as any).data.comments).toBe(
        'budget not approved',
      );
    });

    it('requests a revision with comments (201 RevisionRequired)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ comments: 'add a budget breakdown' })
        .expect(201);

      expect(res.body.status).toBe('RevisionRequired');
      expect(state.row.status).toBe('RevisionRequired');

      const approval = ctx.prisma.callsFor('approval.create')[0] as any;
      expect(approval.data.action).toBe('RevisionRequested');
      expect(approval.data.comments).toBe('add a budget breakdown');
    });

    it('reject without a reason => 400 and the service is never reached', async () => {
      primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({})
        .expect(400);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('request-revision without comments => 400 and the service is never reached', async () => {
      primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({})
        .expect(400);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
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
        'Only a review-role user or the event owner can edit this event',
      );
      expect(state.row.status).toBe('Planning');
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('Draft→Ongoing ⇒ 409 (canTransition false)', async () => {
      primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Ongoing' })
        .expect(409);

      expect(res.body.message).toBe(
        'Invalid event status transition Draft → Ongoing',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it("to: 'Rejected' ⇒ 409 (lifecycle-only targets: allow only Ongoing/Completed in the DTO)", async () => {
      // PendingApproval → Rejected WOULD pass canTransition; only the
      // lifecycle-only target guard can refuse it, which is what pins 409 here.
      primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/advance')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ to: 'Rejected' })
        .expect(409);

      expect(res.body.message).toBe(
        'Advance target must be Ongoing or Completed',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
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

  describe('editing is allowed only in Draft | RevisionRequired', () => {
    it('lets the owner edit a Draft event (200)', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Draft' }));

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

    it('allows editing a RevisionRequired event (200)', async () => {
      primeEventState(ctx, eventRow({ status: 'RevisionRequired' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ venue: 'Main Hall B' })
        .expect(200);

      expect(res.body.venue).toBe('Main Hall B');
    });

    it('refuses to edit an Approved event with 409 (ConflictException)', async () => {
      primeEventState(ctx, eventRow({ status: 'Approved' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Sneaky edit' })
        .expect(409);

      expect(res.body.message).toBe(
        'Event can only be edited while Draft or RevisionRequired (current: Approved)',
      );
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('refuses to edit an Ongoing event with 409', async () => {
      primeEventState(ctx, eventRow({ status: 'Ongoing' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ title: 'Too late' })
        .expect(409);

      expect(res.body.message).toContain('current: Ongoing');
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('refuses an edit from a submit-role user who neither owns nor reviews the event (403)', async () => {
      // Student Officer passes the @Roles gate (it is a submit role) but is
      // neither the owner nor a reviewer, so the service rejects it.
      primeEventState(ctx, eventRow({ createdById: ACTORS.coordinator.sub }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'officer'))
        .send({ title: 'Not yours' })
        .expect(403);

      expect(res.body.message).toBe(
        'Only a review-role user or the event owner can edit this event',
      );
      expect(ctx.prisma.has('event.update')).toBe(false);
    });

    it('PUT cannot change the status: the whitelist strips it', async () => {
      const state = primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .put('/events/ev-1')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({ title: 'Renamed', status: 'Approved' })
        .expect(200);

      expect(res.body.title).toBe('Renamed');
      expect(state.row.status).toBe('Draft');

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

    it('GET /events/:id/approval-history with an unknown id => 404', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events/does-not-exist/approval-history')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(404);

      expect(ctx.prisma.has('approval.findMany')).toBe(false);
    });

    it('a Draft event the caller cannot see answers 404, not 403', async () => {
      primeEventState(ctx, eventRow({ status: 'Draft', createdById: ACTORS.coordinator.sub }));

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
          status: 'Approved',
          isAdmin: true,
        })
        .expect(201);

      expect(res.body.status).toBe('Draft');
      expect(res.body).not.toHaveProperty('isAdmin');

      const created = ctx.prisma.callsFor('event.create')[0] as any;
      expect(created.data.status).toBe('Draft');
      expect(created.data).not.toHaveProperty('isAdmin');
    });
  });
});

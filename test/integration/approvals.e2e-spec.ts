/**
 * HTTP integration tests for the approval workflow through the real app stack
 * (global JWT guard + roles guard + throttler + validation + audit interceptor)
 * with the database mocked. No Postgres connection is opened.
 *
 * Status codes below are what the product code actually does:
 *  - every approval action is a `@Post` without `@HttpCode`, so success is
 *    **201**, not 200;
 *  - `ApprovalsService` writes status changes with
 *    `event.updateMany({ where: { id, status: from }, data: { status: to } })`
 *    and throws `ConflictException` (409) for an illegal transition.
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
    status: 'PendingApproval',
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

/** One-row in-memory `event` table so transitions can be walked over HTTP. */
function primeEventState(
  ctx: TestApp,
  initial: Record<string, unknown> = eventRow(),
): EventState {
  const state: EventState = { row: initial };
  ctx.prisma.on('event.findUnique', () => state.row);
  ctx.prisma.on('event.updateMany', (args: any) => {
    state.row = { ...state.row, ...args.data };
    return { count: 1 };
  });
  return state;
}

describe('Approvals API (mocked database)', () => {
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

  describe('guard stack: anonymous callers get 401', () => {
    it('GET /approvals/pending without a token => 401 and the queue is never queried', async () => {
      await request(ctx.app.getHttpServer()).get('/approvals/pending').expect(401);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
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

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
    });

    it('POST /events/:id/request-revision without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .send({ comments: 'fix' })
        .expect(401);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
    });

    it('POST /events/:id/submit without a token => 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .send({})
        .expect(401);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
    });
  });

  describe('role matrix on approve / reject / request-revision', () => {
    it('an Instructor is denied approve (403) before the service runs', async () => {
      primeEventState(ctx);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({})
        .expect(403);

      expect(res.body.message).toMatch(/forbidden/i);
      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('an Instructor is denied reject (403)', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ reason: 'not for you' })
        .expect(403);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('an Instructor is denied request-revision (403)', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({ comments: 'not for you' })
        .expect(403);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('a Student is denied approve (403)', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({})
        .expect(403);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('a Student is denied reject (403)', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ reason: 'nope' })
        .expect(403);

      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('a Student is denied request-revision (403)', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ comments: 'nope' })
        .expect(403);

      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('a Department Head may approve (201, event lands in Planning)', async () => {
      const state = primeEventState(ctx);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({})
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(state.row.status).toBe('Planning');
      expect((ctx.prisma.callsFor('event.updateMany') as any[])[0]).toEqual({
        where: { id: 'ev-1', status: 'PendingApproval' },
        data: { status: 'Approved' },
      });
    });

    it('an Event Coordinator may approve (201)', async () => {
      const state = primeEventState(ctx);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({})
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(state.row.status).toBe('Planning');
    });

    it('an Admin may approve (201)', async () => {
      const state = primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({})
        .expect(201);

      expect(state.row.status).toBe('Planning');
    });

    it('a Department Head may reject (201 Rejected)', async () => {
      const state = primeEventState(ctx);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/reject')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ reason: 'out of budget' })
        .expect(201);

      expect(res.body.status).toBe('Rejected');
      expect(state.row.status).toBe('Rejected');
      expect((ctx.prisma.callsFor('approval.create')[0] as any).data).toMatchObject({
        action: 'Rejected',
        comments: 'out of budget',
      });
    });

    it('an Admin may request a revision (201 RevisionRequired)', async () => {
      const state = primeEventState(ctx);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/request-revision')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .send({ comments: 'please add signage photos' })
        .expect(201);

      expect(res.body.status).toBe('RevisionRequired');
      expect(state.row.status).toBe('RevisionRequired');
      expect((ctx.prisma.callsFor('approval.create')[0] as any).data.action).toBe(
        'RevisionRequested',
      );
    });
  });

  describe('GET /approvals/pending queue', () => {
    const queueRow = (id: string, title: string) => ({
      id,
      title,
      venue: 'Main Hall',
      eventDate: '2026-06-01T00:00:00.000Z',
      status: 'PendingApproval',
      approvals: [],
    });

    function primeQueue() {
      ctx.prisma.on('event.findMany', [queueRow('ev-1', 'Career Fair'), queueRow('ev-2', 'Hackathon')]);
      ctx.prisma.on('event.count', 2);
    }

    it('an Instructor is denied the queue (403)', async () => {
      await request(ctx.app.getHttpServer())
        .get('/approvals/pending')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .expect(403);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('a Student is denied the queue (403)', async () => {
      await request(ctx.app.getHttpServer())
        .get('/approvals/pending')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .expect(403);

      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('a Department Head gets 200 with the pending rows and the PendingApproval filter', async () => {
      primeQueue();

      const res = await request(ctx.app.getHttpServer())
        .get('/approvals/pending')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .expect(200);

      expect(res.body.total).toBe(2);
      expect(res.body.items.map((item: any) => item.title)).toEqual([
        'Career Fair',
        'Hackathon',
      ]);

      const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
      expect(findMany.where).toEqual({ status: 'PendingApproval' });
      expect(findMany.include.approvals).toEqual({
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(findMany.orderBy).toEqual([
        { eventDate: 'asc' },
        { createdAt: 'asc' },
      ]);
    });

    it('an Event Coordinator gets 200 from the queue', async () => {
      primeQueue();

      const res = await request(ctx.app.getHttpServer())
        .get('/approvals/pending')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .expect(200);

      expect(res.body.items).toHaveLength(2);
      expect((ctx.prisma.callsFor('event.findMany')[0] as any).where).toEqual({
        status: 'PendingApproval',
      });
    });

    it('a Student Officer gets 200 from the queue (submit role)', async () => {
      primeQueue();

      await request(ctx.app.getHttpServer())
        .get('/approvals/pending')
        .set('Authorization', await bearerFor(ctx, 'officer'))
        .expect(200);
    });
  });

  describe('workflow rules', () => {
    it('an Instructor who does not own the event cannot submit it (403 from the service)', async () => {
      // POST /events/:id/submit carries no @Roles decorator, so the guard
      // stack lets an Instructor through and the ownership check must stop it.
      primeEventState(ctx, eventRow({ status: 'Draft' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .set('Authorization', await bearerFor(ctx, 'instructor'))
        .send({})
        .expect(403);

      expect(res.body.message).toBe(
        'Only the event owner or a submit-role user can submit',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });

    it('the owner may submit their own Draft even without a submit role (201)', async () => {
      const state = primeEventState(
        ctx,
        eventRow({ status: 'Draft', createdById: ACTORS.student.sub }),
      );

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .set('Authorization', await bearerFor(ctx, 'student'))
        .send({ comments: 'my first event' })
        .expect(201);

      expect(res.body.status).toBe('PendingApproval');
      expect(state.row.status).toBe('PendingApproval');
      expect((ctx.prisma.callsFor('approval.create')[0] as any).data).toMatchObject({
        action: 'Submitted',
        reviewerId: ACTORS.student.sub,
      });
    });

    it('submitting an already pending event => 409 invalid transition', async () => {
      primeEventState(ctx, eventRow({ status: 'PendingApproval' }));

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/submit')
        .set('Authorization', await bearerFor(ctx, 'coordinator'))
        .send({})
        .expect(409);

      expect(res.body.message).toBe(
        'Invalid event status transition PendingApproval → PendingApproval',
      );
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
      expect(ctx.prisma.has('approval.create')).toBe(false);
    });

    it('a venue conflict blocks approval with 409 + requiresOverride unless overridden', async () => {
      primeEventState(ctx);
      ctx.prisma.on('event.findFirst', {
        id: 'ev-other',
        title: 'Alumni Night',
        venue: 'Main Hall',
        eventDate: new Date('2026-06-01T00:00:00.000Z'),
      });

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({})
        .expect(409);

      expect(res.body.requiresOverride).toBe(true);
      expect(res.body.message).toContain('Venue conflict');
      expect(res.body.conflict.id).toBe('ev-other');
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
      expect(ctx.prisma.has('approval.create')).toBe(false);
    });

    it('overrideConflict: true clears the conflict, records the audit trail and returns Planning (201)', async () => {
      primeEventState(ctx);
      ctx.prisma.on('event.findFirst', {
        id: 'ev-other',
        title: 'Alumni Night',
        venue: 'Main Hall',
        eventDate: new Date('2026-06-01T00:00:00.000Z'),
      });

      const res = await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ overrideConflict: true, comments: 'double-booked on purpose' })
        .expect(201);

      expect(res.body.status).toBe('Planning');
      expect(res.body.conflictWarning).toContain('Venue conflict');

      const audits = ctx.prisma.callsFor('auditLog.create') as any[];
      expect(
        audits.some((entry) => entry.data?.body?.action === 'approve'),
      ).toBe(true);
      expect(ctx.prisma.has('approval.create')).toBe(true);
    });

    it('overrideConflict must be a boolean: a string => 400 and the service is never reached', async () => {
      primeEventState(ctx);

      await request(ctx.app.getHttpServer())
        .post('/events/ev-1/approve')
        .set('Authorization', await bearerFor(ctx, 'head'))
        .send({ overrideConflict: 'true' })
        .expect(400);

      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('event.updateMany')).toBe(false);
    });
  });

  describe('GET /events/:id/approval-history', () => {
    it('returns the scripted history for a visible event (200)', async () => {
      primeEventState(ctx);
      ctx.prisma.on('approval.findMany', [
        {
          id: 'ap-1',
          eventId: 'ev-1',
          action: 'Submitted',
          comments: 'ready',
          reviewer: { id: 'u-coord', firstName: 'coord', lastName: 'Tester' },
        },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/events/ev-1/approval-history')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        action: 'Submitted',
        reviewer: { id: 'u-coord' },
      });

      const history = ctx.prisma.callsFor('approval.findMany')[0] as any;
      expect(history.where).toEqual({ eventId: 'ev-1' });
      expect(history.orderBy).toEqual({ createdAt: 'asc' });
    });

    it('an unknown event id => 404 before the history query', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events/does-not-exist/approval-history')
        .set('Authorization', await bearerFor(ctx, 'admin'))
        .expect(404);

      expect(ctx.prisma.has('approval.findMany')).toBe(false);
    });
  });
});

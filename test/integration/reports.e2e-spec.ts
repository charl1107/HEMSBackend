/**
 * HTTP integration tests for /reports through the real app stack (global JWT
 * guard + roles guard + throttler + validation) with the database mocked. No
 * Postgres connection is opened. The summary carries the four event
 * breakdowns only — there is no `tasks` key since Amendment 2.
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

const NON_REPORT_ACTORS: ActorName[] = ['coordinator', 'instructor', 'officer', 'student'];

/** Event rows the summary aggregates: two events over two months and scopes. */
const SUMMARY_EVENT_ROWS = [
  {
    status: 'Completed',
    eventTypeId: 'type-1',
    eventDate: new Date('2026-01-15T00:00:00Z'),
    campusScope: 'OnCampus',
  },
  {
    status: 'Planning',
    eventTypeId: null,
    eventDate: new Date('2026-02-02T00:00:00Z'),
    campusScope: 'OffCampus',
  },
];

describe('reports API (mocked database)', () => {
  let ctx: TestApp;

  /** Rows the fake resolves `user.findUnique` to, keyed by user id. */
  const users: Record<string, Record<string, unknown>> = {};

  const auth = (name: ActorName) =>
    ctx.bearer({ sub: ACTORS[name].sub, email: ACTORS[name].email });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.prisma.reset();
    for (const key of Object.keys(users)) {
      delete users[key];
    }
    for (const name of Object.keys(ACTORS) as ActorName[]) {
      users[ACTORS[name].sub] = userRowFor(name);
    }
    ctx.prisma.on(
      'user.findUnique',
      (args: { where?: { id?: string; email?: string } } | undefined) => {
        const where = args?.where;
        if (where?.id) {
          return users[where.id] ?? null;
        }
        if (where?.email) {
          return (
            Object.values(users).find((row) => row.email === where.email) ?? null
          );
        }
        return null;
      },
    );
  });

  describe('GET /reports/summary', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .expect(401);
      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('returns event statistics with no tasks key for Admin', async () => {
      ctx.prisma.on('event.findMany', SUMMARY_EVENT_ROWS);
      ctx.prisma.on('eventType.findMany', [{ id: 'type-1', name: 'Seminar' }]);

      const res = await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .set('Authorization', await auth('admin'))
        .expect(200);

      expect(res.body).toEqual({
        events: {
          total: 2,
          byStatus: { Completed: 1, Planning: 1 },
          byType: { Seminar: 1, Uncategorized: 1 },
          byMonth: { '2026-01': 1, '2026-02': 1 },
          byCampusScope: { OnCampus: 1, OffCampus: 1 },
        },
      });
      expect('tasks' in res.body).toBe(false);
      expect(ctx.prisma.has('eventTask.groupBy')).toBe(false);
    });

    it('lets a Department Head read the summary', async () => {
      ctx.prisma.on('event.findMany', SUMMARY_EVENT_ROWS);
      ctx.prisma.on('eventType.findMany', [{ id: 'type-1', name: 'Seminar' }]);

      const res = await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .set('Authorization', await auth('head'))
        .expect(200);

      expect(res.body.events.total).toBe(2);
      expect('tasks' in res.body).toBe(false);
    });

    it('forbids Coordinator, Instructor, Student Officer and Student from the summary with 403', async () => {
      for (const name of NON_REPORT_ACTORS) {
        const res = await request(ctx.app.getHttpServer())
          .get('/reports/summary')
          .set('Authorization', await auth(name))
          .expect(403);
        expect(res.body.statusCode).toBe(403);
      }
      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });
  });
});

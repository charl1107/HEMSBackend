/**
 * HTTP integration tests for /audit and /notifications through the real app
 * stack (global JWT guard + roles guard + throttler + audit interceptor +
 * validation) with the database mocked. No Postgres connection is opened.
 *
 * Proves two things:
 *  1. GET /audit is Admin-only, and the interceptor's audit writes never
 *     persist denylisted keys (password / passwordHash / token / refreshToken
 *     / authorization — see src/audit/sanitize.ts).
 *  2. The notifications inbox is scoped to the caller: list filters by the
 *     caller's user id and mark-read only succeeds for the owner.
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

const NON_ADMIN_ACTORS: ActorName[] = [
  'head',
  'coordinator',
  'instructor',
  'officer',
  'student',
];

/** Waits (bounded) for the interceptor's async audit write to land in the fake. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('audit + notifications API (mocked database)', () => {
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

  describe('GET /audit', () => {
    it('rejects every non-Admin role with 403', async () => {
      for (const name of NON_ADMIN_ACTORS) {
        const res = await request(ctx.app.getHttpServer())
          .get('/audit')
          .set('Authorization', await auth(name))
          .expect(403);
        expect(res.body.statusCode).toBe(403);
      }
      expect(ctx.prisma.has('auditLog.findMany')).toBe(false);
    });

    it('returns the audit page to Admin with 200', async () => {
      ctx.prisma.on('auditLog.findMany', [
        {
          id: 'log-1',
          userId: ACTORS.admin.sub,
          user: {
            id: ACTORS.admin.sub,
            email: ACTORS.admin.email,
            firstName: 'admin',
            lastName: 'Tester',
          },
          method: 'POST',
          path: '/users/u-2/roles',
          body: { role: 'Instructor' },
          statusCode: 201,
          createdAt: new Date('2026-01-12T10:00:00Z'),
        },
      ]);
      ctx.prisma.on('auditLog.count', 7);

      const res = await request(ctx.app.getHttpServer())
        .get('/audit')
        .set('Authorization', await auth('admin'))
        .expect(200);

      expect(res.body).toMatchObject({ total: 7, page: 1, pageSize: 20 });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        method: 'POST',
        path: '/users/u-2/roles',
        entity: 'users',
        action: 'roles',
        statusCode: 201,
      });
      // Listing is a GET: nothing new is audited by the act of reading.
      expect(ctx.prisma.has('auditLog.create')).toBe(false);
    });

    it('rejects unauthenticated access with 401', async () => {
      await request(ctx.app.getHttpServer()).get('/audit').expect(401);
      expect(ctx.prisma.has('auditLog.findMany')).toBe(false);
    });
  });

  describe('audit denylist', () => {
    it('strips password, passwordHash, token, refreshToken and authorization from the audited payload', async () => {
      ctx.prisma.on('role.findMany', [
        { id: 'role-Instructor', name: 'Instructor' },
      ]);
      ctx.prisma.on('user.create', (args: { data: Record<string, unknown> }) => ({
        id: 'u-audited',
        ...args.data,
        userRoles: [
          { id: 'ur-a-0', role: { id: 'role-Instructor', name: 'Instructor' } },
        ],
      }));

      await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', await auth('admin'))
        .send({
          email: 'audit-me@hems.local',
          password: 'Sup3rSecret!',
          firstName: 'Audit',
          lastName: 'Subject',
          roles: ['Instructor'],
          // Extra denylisted keys: unknown to CreateUserDto (the pipe strips
          // them from the handler's DTO) but still present on the raw body
          // the interceptor hands to AuditService.
          passwordHash: 'not-a-real-hash',
          token: 'access-token-value',
          refreshToken: 'refresh-token-value',
          authorization: 'Bearer attacker-supplied',
        })
        .expect(201);

      // The interceptor writes on response 'finish'; give it a beat.
      await waitFor(() => ctx.prisma.has('auditLog.create'));
      expect(ctx.prisma.has('auditLog.create')).toBe(true);

      const audit = ctx.prisma.callsFor('auditLog.create')[0] as {
        data: Record<string, unknown>;
      };
      expect(audit.data).toMatchObject({
        userId: ACTORS.admin.sub,
        method: 'POST',
        statusCode: 201,
      });
      expect(String(audit.data.path)).toContain('/users');
      expect(audit.data.body).toEqual({
        email: 'audit-me@hems.local',
        firstName: 'Audit',
        lastName: 'Subject',
        roles: ['Instructor'],
      });

      const persisted = JSON.stringify(audit.data).toLowerCase();
      for (const banned of [
        'password',
        'passwordhash',
        'token',
        'refreshtoken',
        'authorization',
      ]) {
        expect(persisted).not.toContain(banned);
      }
      expect(persisted).not.toContain('sup3rsecret!');
      expect(persisted).not.toContain('attacker-supplied');
    });

    it('writes no audit record for a mutation the guard rejects with 403', async () => {
      await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', await auth('student'))
        .send({
          email: 'denied@hems.local',
          password: 'Sup3rSecret!',
          firstName: 'No',
          lastName: 'Permission',
        })
        .expect(403);

      await sleep(50);
      expect(ctx.prisma.has('auditLog.create')).toBe(false);
      expect(ctx.prisma.has('user.create')).toBe(false);
    });
  });

  describe('GET /notifications', () => {
    it('requires authentication with 401', async () => {
      await request(ctx.app.getHttpServer()).get('/notifications').expect(401);
      expect(ctx.prisma.has('notification.findMany')).toBe(false);
    });

    it("returns only the caller's notifications, filtering by the caller's user id", async () => {
      ctx.prisma.on('notification.findMany', [
        {
          id: 'n-1',
          userId: ACTORS.student.sub,
          eventId: null,
          type: 'TaskAssigned',
          message: 'You were assigned a task',
          isRead: false,
          createdAt: new Date('2026-01-10T08:00:00Z'),
          updatedAt: new Date('2026-01-10T08:00:00Z'),
        },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/notifications')
        .set('Authorization', await auth('student'))
        .expect(200);

      const listArgs = ctx.prisma.callsFor('notification.findMany')[0] as {
        where: Record<string, unknown>;
      };
      expect(listArgs.where).toEqual({ userId: ACTORS.student.sub });
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: 'n-1',
        userId: ACTORS.student.sub,
        message: 'You were assigned a task',
      });
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    /** Simulates the real updateMany semantics: only rows owned by `ownerId` match. */
    const scriptOwnerScopedUpdate = (ownerId: string) =>
      ctx.prisma.on(
        'notification.updateMany',
        (args: { where?: { userId?: string } } | undefined) => ({
          count: args?.where?.userId === ownerId ? 1 : 0,
        }),
      );

    it('lets the owner mark their own notification as read', async () => {
      scriptOwnerScopedUpdate(ACTORS.student.sub);
      ctx.prisma.on('notification.findUnique', {
        id: 'n-1',
        userId: ACTORS.student.sub,
        eventId: null,
        type: 'TaskAssigned',
        message: 'You were assigned a task',
        isRead: true,
        createdAt: new Date('2026-01-10T08:00:00Z'),
        updatedAt: new Date('2026-01-11T08:00:00Z'),
      });

      const res = await request(ctx.app.getHttpServer())
        .patch('/notifications/n-1/read')
        .set('Authorization', await auth('student'))
        .expect(200);

      expect(res.body).toMatchObject({ id: 'n-1', isRead: true });

      const updateArgs = ctx.prisma.callsFor('notification.updateMany')[0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(updateArgs.where).toEqual({
        id: 'n-1',
        userId: ACTORS.student.sub,
      });
      expect(updateArgs.data).toEqual({ isRead: true });
    });

    it("refuses to mark someone else's notification as read with 404", async () => {
      // n-7 belongs to the Admin, so the scoped update matches no row for the
      // Student caller and the service reports the notification as not found.
      scriptOwnerScopedUpdate(ACTORS.admin.sub);

      const res = await request(ctx.app.getHttpServer())
        .patch('/notifications/n-7/read')
        .set('Authorization', await auth('student'))
        .expect(404);

      expect(res.body.message).toBe('Notification not found');

      const updateArgs = ctx.prisma.callsFor('notification.updateMany')[0] as {
        where: Record<string, unknown>;
      };
      expect(updateArgs.where).toEqual({
        id: 'n-7',
        userId: ACTORS.student.sub,
      });
      expect(ctx.prisma.has('notification.findUnique')).toBe(false);
    });
  });
});

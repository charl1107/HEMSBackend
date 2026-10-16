/**
 * HTTP integration tests for /users through the real app stack
 * (global JWT guard + roles guard + throttler + validation + audit interceptor)
 * with the database mocked. No Postgres connection is opened.
 *
 * Focus: the role matrix (F30). Reads (`GET /users`, `GET /users/:id`) are
 * open to `Admin` + `DIRECTORY_READ_ROLES` (Event Coordinator, Instructor,
 * Student Officer, Department Head); every write route stays Admin-only, so
 * non-Admin writers get 403, nobody gets 401 without a token, and no
 * password/hash field may ever appear in a response body (asserted
 * recursively over the parsed JSON). The validation pipe / DTOs must reject
 * bad input before the service is ever reached.
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

/** Roles that must NOT be able to write to the user management API. */
const NON_ADMIN_ACTORS: ActorName[] = [
  'head',
  'coordinator',
  'instructor',
  'officer',
  'student',
];

/** Directory-reader roles that must be able to READ the directory (F30). */
const DIRECTORY_READ_ACTORS: ActorName[] = [
  'head',
  'coordinator',
  'instructor',
  'officer',
];

/** Every object key of a parsed JSON body, at any depth. */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** No credential field may survive sanitisation, at any depth. */
function expectNoPasswordKeys(body: unknown): void {
  const keys = collectKeys(body);
  expect(keys).not.toContain('password');
  expect(keys).not.toContain('passwordHash');
  expect(JSON.stringify(body)).not.toContain('$2b$10$');
}

const NEW_USER_BODY = {
  email: 'newbie@hems.local',
  password: 'Sup3rSecret!',
  firstName: 'New',
  lastName: 'User',
};

describe('users API (mocked database)', () => {
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
    // One responder answers both callers of `user.findUnique`: the JWT
    // strategy (where: { id }) and the service's duplicate-email check
    // (where: { email }). Unknown ids/emails resolve to null, exactly like
    // the real client would.
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

  describe('GET /users', () => {
    it('lets a Department Head list users with 200 (DIRECTORY_READ_ROLES, F30)', async () => {
      ctx.prisma.on('user.findMany', [userRowFor('student')]);

      const res = await request(ctx.app.getHttpServer())
        .get('/users')
        .set('Authorization', await auth('head'))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: ACTORS.student.sub,
        email: ACTORS.student.email,
        roles: ['Student'],
      });
    });

    it('lets an Instructor list users with 200 (DIRECTORY_READ_ROLES, F30)', async () => {
      ctx.prisma.on('user.findMany', [userRowFor('coordinator')]);

      const res = await request(ctx.app.getHttpServer())
        .get('/users')
        .set('Authorization', await auth('instructor'))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: ACTORS.coordinator.sub });
    });

    it('lets every directory-reader role read the directory with 200', async () => {
      for (const name of DIRECTORY_READ_ACTORS) {
        ctx.prisma.on('user.findMany', [userRowFor('student')]);
        await request(ctx.app.getHttpServer())
          .get('/users')
          .set('Authorization', await auth(name))
          .expect(200);
      }
    });

    it('still rejects a Student with 403 on GET /users', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get('/users')
        .set('Authorization', await auth('student'))
        .expect(403);
      expect(res.body.statusCode).toBe(403);
      expect(ctx.prisma.has('user.findMany')).toBe(false);
    });

    it('never exposes a password or passwordHash key anywhere in the parsed list body', async () => {
      ctx.prisma.on('user.findMany', [
        { ...userRowFor('student'), passwordHash: '$2b$10$leakedhashvalue' },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/users')
        .set('Authorization', await auth('head'))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expectNoPasswordKeys(res.body);
    });

    it('lets Admin list users with 200 and never leaks the password hash', async () => {
      ctx.prisma.on('user.findMany', [
        { ...userRowFor('student'), passwordHash: '$2b$10$leakedhashvalue' },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/users')
        .set('Authorization', await auth('admin'))
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({
        id: ACTORS.student.sub,
        email: ACTORS.student.email,
        roles: ['Student'],
      });
      expect(res.body[0]).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('$2b$10$');
    });

    it('rejects an unauthenticated list request with 401', async () => {
      await request(ctx.app.getHttpServer()).get('/users').expect(401);
      expect(ctx.prisma.has('user.findMany')).toBe(false);
    });
  });

  describe('GET /users/:id', () => {
    beforeEach(() => {
      users['u-admin'] = {
        ...userRowFor('admin'),
        passwordHash: '$2b$10$adminhashvalue',
      };
    });

    it('lets an Instructor read a single user with 200 (DIRECTORY_READ_ROLES, F30)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/users/${ACTORS.admin.sub}`)
        .set('Authorization', await auth('instructor'))
        .expect(200);

      expect(res.body).toMatchObject({
        id: ACTORS.admin.sub,
        email: ACTORS.admin.email,
        roles: ['Admin'],
      });
      expectNoPasswordKeys(res.body);
    });

    it('lets a Department Head read a single user with 200 (DIRECTORY_READ_ROLES, F30)', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/users/${ACTORS.instructor.sub}`)
        .set('Authorization', await auth('head'))
        .expect(200);

      expect(res.body).toMatchObject({
        id: ACTORS.instructor.sub,
        roles: ['Instructor'],
      });
    });

    it('still rejects a Student with 403 on GET /users/:id before the service runs', async () => {
      const res = await request(ctx.app.getHttpServer())
        .get(`/users/${ACTORS.admin.sub}`)
        .set('Authorization', await auth('student'))
        .expect(403);
      expect(res.body.statusCode).toBe(403);
      // Only the JWT strategy's caller lookup ran — `findOne` never did.
      expect(ctx.prisma.callsFor('user.findUnique')).toHaveLength(1);
    });

    it('rejects an unauthenticated single-user read with 401', async () => {
      await request(ctx.app.getHttpServer())
        .get(`/users/${ACTORS.admin.sub}`)
        .expect(401);
    });
  });

  describe('POST /users', () => {
    it('rejects creation by every non-Admin role with 403 before the service runs', async () => {
      for (const name of NON_ADMIN_ACTORS) {
        await request(ctx.app.getHttpServer())
          .post('/users')
          .set('Authorization', await auth(name))
          .send({ ...NEW_USER_BODY, email: `${name}-denied@hems.local` })
          .expect(403);
      }
      expect(ctx.prisma.has('user.create')).toBe(false);
      expect(ctx.prisma.has('role.findMany')).toBe(false);
    });

    it('creates a user for Admin with 201 and hashes the password server-side', async () => {
      ctx.prisma.on('role.findMany', [
        { id: 'role-Instructor', name: 'Instructor' },
      ]);
      ctx.prisma.on('user.create', (args: { data: Record<string, unknown> }) => ({
        id: 'u-new',
        ...args.data,
        userRoles: [
          { id: 'ur-new-0', role: { id: 'role-Instructor', name: 'Instructor' } },
        ],
      }));

      const res = await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', await auth('admin'))
        .send({ ...NEW_USER_BODY, roles: ['Instructor'] })
        .expect(201);

      expect(res.body).toMatchObject({
        id: 'u-new',
        email: NEW_USER_BODY.email,
        firstName: 'New',
        lastName: 'User',
        roles: ['Instructor'],
        mustChangePassword: true,
      });
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('Sup3rSecret!');

      const write = ctx.prisma.callsFor('user.create')[0] as {
        data: Record<string, unknown>;
      };
      expect(String(write.data.passwordHash)).toMatch(/^\$2[aby]\$/);
      expect(write.data.passwordHash).not.toBe(NEW_USER_BODY.password);
      expect(write.data.mustChangePassword).toBe(true);
    });

    it('rejects a missing or malformed email with 400 before reaching the service', async () => {
      const admin = await auth('admin');

      const missing = await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', admin)
        .send({ password: 'Sup3rSecret!', firstName: 'No', lastName: 'Email' })
        .expect(400);
      expect(JSON.stringify(missing.body)).toContain('email');

      const malformed = await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', admin)
        .send({
          email: 'not-an-email',
          password: 'Sup3rSecret!',
          firstName: 'Bad',
          lastName: 'Email',
        })
        .expect(400);
      expect(JSON.stringify(malformed.body)).toContain('email');

      // Only the two JWT lookups ran — the pipe rejected both bodies before
      // the service's duplicate-email check or `user.create` could be reached.
      expect(ctx.prisma.callsFor('user.findUnique')).toHaveLength(2);
      expect(ctx.prisma.has('user.create')).toBe(false);
    });

    it('refuses to grant the Admin role through POST /users with 400', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', await auth('admin'))
        .send({ ...NEW_USER_BODY, roles: ['Admin'] })
        .expect(400);

      expect(res.body.message).toBe(
        'Admin role can only be granted directly in the database',
      );
      expect(ctx.prisma.has('user.create')).toBe(false);
    });

    it('rejects an unknown role with 404 from the service role lookup', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/users')
        .set('Authorization', await auth('admin'))
        .send({ ...NEW_USER_BODY, roles: ['Wizard'] })
        .expect(404);

      expect(res.body.message).toBe('One or more roles do not exist');
      expect(ctx.prisma.has('role.findMany')).toBe(true);
      expect(ctx.prisma.has('user.create')).toBe(false);
    });

    it('rejects unauthenticated create, update and role-assignment requests with 401', async () => {
      await request(ctx.app.getHttpServer())
        .post('/users')
        .send(NEW_USER_BODY)
        .expect(401);
      await request(ctx.app.getHttpServer())
        .patch('/users/u-2')
        .send({ firstName: 'Ghost' })
        .expect(401);
      await request(ctx.app.getHttpServer())
        .post('/users/u-2/roles')
        .send({ role: 'Instructor' })
        .expect(401);

      expect(ctx.prisma.has('user.create')).toBe(false);
      expect(ctx.prisma.has('user.update')).toBe(false);
      expect(ctx.prisma.has('userRole.upsert')).toBe(false);
    });
  });

  describe('PATCH /users/:id', () => {
    it('rejects updates by every non-Admin role with 403', async () => {
      for (const name of NON_ADMIN_ACTORS) {
        await request(ctx.app.getHttpServer())
          .patch(`/users/${ACTORS.student.sub}`)
          .set('Authorization', await auth(name))
          .send({ firstName: 'Hacked' })
          .expect(403);
      }
      expect(ctx.prisma.has('user.update')).toBe(false);
    });

    it('lets Admin rename a user and reset a password with 200, storing only a hash', async () => {
      users['u-2'] = {
        ...userRowFor('student'),
        id: 'u-2',
        email: 'target@hems.local',
      };
      ctx.prisma.on('user.update', (args: { data: Record<string, unknown> }) => ({
        ...users['u-2'],
        ...args.data,
        id: 'u-2',
      }));

      const res = await request(ctx.app.getHttpServer())
        .patch('/users/u-2')
        .set('Authorization', await auth('admin'))
        .send({ firstName: 'Renamed', password: 'NewPassw0rd!' })
        .expect(200);

      expect(res.body).toMatchObject({
        id: 'u-2',
        firstName: 'Renamed',
        roles: ['Student'],
      });
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passwordHash');

      const write = ctx.prisma.callsFor('user.update')[0] as {
        data: Record<string, unknown>;
      };
      expect(write.data).toHaveProperty('firstName', 'Renamed');
      expect(write.data).not.toHaveProperty('password');
      expect(String(write.data.passwordHash)).toMatch(/^\$2[aby]\$/);
      expect(write.data.passwordHash).not.toBe('NewPassw0rd!');
    });

    it('rejects a short password with 400 before reaching the service', async () => {
      users['u-2'] = {
        ...userRowFor('student'),
        id: 'u-2',
        email: 'target@hems.local',
      };

      const res = await request(ctx.app.getHttpServer())
        .patch('/users/u-2')
        .set('Authorization', await auth('admin'))
        .send({ password: 'short' })
        .expect(400);
      expect(JSON.stringify(res.body)).toContain('password');

      expect(ctx.prisma.has('user.update')).toBe(false);
      // JWT lookup only: `UsersService.update` never ran `findOne`.
      expect(ctx.prisma.callsFor('user.findUnique')).toHaveLength(1);
    });
  });

  describe('POST /users/:id/roles', () => {
    it('rejects role assignment by every non-Admin role with 403', async () => {
      for (const name of NON_ADMIN_ACTORS) {
        await request(ctx.app.getHttpServer())
          .post(`/users/${ACTORS.student.sub}/roles`)
          .set('Authorization', await auth(name))
          .send({ role: 'Instructor' })
          .expect(403);
      }
      expect(ctx.prisma.has('userRole.upsert')).toBe(false);
      expect(ctx.prisma.has('role.findUnique')).toBe(false);
    });

    it('assigns a valid role for Admin with 201', async () => {
      users['u-2'] = {
        ...userRowFor('student'),
        id: 'u-2',
        email: 'target@hems.local',
      };
      ctx.prisma.on(
        'role.findUnique',
        (args: { where?: { name?: string } } | undefined) =>
          args?.where?.name === 'Instructor'
            ? { id: 'role-Instructor', name: 'Instructor' }
            : null,
      );

      const res = await request(ctx.app.getHttpServer())
        .post('/users/u-2/roles')
        .set('Authorization', await auth('admin'))
        .send({ role: 'Instructor' })
        .expect(201);

      expect(res.body).toMatchObject({ id: 'u-2', email: 'target@hems.local' });
      expect(ctx.prisma.callsFor('userRole.upsert')[0]).toEqual({
        where: { userId_roleId: { userId: 'u-2', roleId: 'role-Instructor' } },
        create: { userId: 'u-2', roleId: 'role-Instructor' },
        update: {},
      });
    });

    it('validates the requested role against the allow-list with 400', async () => {
      const admin = await auth('admin');

      const adminRole = await request(ctx.app.getHttpServer())
        .post(`/users/${ACTORS.student.sub}/roles`)
        .set('Authorization', admin)
        .send({ role: 'Admin' })
        .expect(400);
      expect(JSON.stringify(adminRole.body.message)).toContain(
        'role must be one of the following values',
      );
      expect(JSON.stringify(adminRole.body.message)).toContain('Student Officer');

      const unknownRole = await request(ctx.app.getHttpServer())
        .post(`/users/${ACTORS.student.sub}/roles`)
        .set('Authorization', admin)
        .send({ role: 'Super Admin' })
        .expect(400);
      expect(JSON.stringify(unknownRole.body.message)).toContain(
        'role must be one of the following values',
      );

      expect(ctx.prisma.has('userRole.upsert')).toBe(false);
      expect(ctx.prisma.has('role.findUnique')).toBe(false);
    });
  });

  describe('DELETE /users/:id and role-removal routes', () => {
    it('rejects every non-Admin role with 403 before the service runs', async () => {
      for (const name of NON_ADMIN_ACTORS) {
        await request(ctx.app.getHttpServer())
          .delete(`/users/${ACTORS.student.sub}`)
          .set('Authorization', await auth(name))
          .expect(403);
        await request(ctx.app.getHttpServer())
          .delete(`/users/${ACTORS.student.sub}/roles/by-name/Instructor`)
          .set('Authorization', await auth(name))
          .expect(403);
        await request(ctx.app.getHttpServer())
          .delete(`/users/${ACTORS.student.sub}/roles/role-Instructor`)
          .set('Authorization', await auth(name))
          .expect(403);
      }
      expect(ctx.prisma.has('user.delete')).toBe(false);
      expect(ctx.prisma.has('userRole.delete')).toBe(false);
    });
  });
});

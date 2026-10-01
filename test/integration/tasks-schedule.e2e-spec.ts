/**
 * HTTP integration tests for tasks & schedule through the real app stack
 * (global JWT guard + roles guard + throttler + validation pipe +
 * audit interceptor) with the database mocked. No Postgres connection is
 * opened.
 *
 * Both services share `src/common/planning-access.ts`: the event owner, a
 * committee member of the event, Admin or Department Head may manage tasks
 * and schedule; a Cancelled/Rejected event is refused with 409.
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

const EVENT_ID = 'ev-planning';
const TASK_ID = 'task-1';
const SCHEDULE_ID = 'sched-1';
const TASKS_URL = `/events/${EVENT_ID}/tasks`;
const SCHEDULE_URL = `/events/${EVENT_ID}/schedule`;

const MANAGE_DENIED =
  'Only the event owner, a committee member of this event, Admin, or Department Head can manage tasks and schedule';

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
    createdById: opts.createdById ?? ACTORS.coordinator.sub,
  };
  // Id-aware: any other event id must still resolve to null (404).
  ctx.prisma.on(
    'event.findUnique',
    (args: any) => (args?.where?.id === EVENT_ID ? row : null),
  );
}

describe('events/:eventId/tasks and /schedule (mocked database)', () => {
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

  it('rejects every task and schedule route without a token with 401 before any query runs', async () => {
    const server = ctx.app.getHttpServer();
    const routes: Array<[string, string]> = [
      ['get', TASKS_URL],
      ['post', TASKS_URL],
      ['patch', `${TASKS_URL}/${TASK_ID}`],
      ['delete', `${TASKS_URL}/${TASK_ID}`],
      ['get', SCHEDULE_URL],
      ['post', SCHEDULE_URL],
      ['patch', `${SCHEDULE_URL}/${SCHEDULE_ID}`],
      ['delete', `${SCHEDULE_URL}/${SCHEDULE_ID}`],
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

  it('lets Admin and Department Head create tasks (201) and writes Todo rows', async () => {
    scriptEvent(ctx);

    for (const name of ['admin', 'head'] as const) {
      const bearer = await bearerFor(ctx, name);
      const res = await request(ctx.app.getHttpServer())
        .post(TASKS_URL)
        .set('Authorization', bearer)
        .send({ title: `Task by ${name}`, deadline: '2026-05-01T12:00:00.000Z' })
        .expect(201);

      expect(res.body, name).toMatchObject({
        eventId: EVENT_ID,
        title: `Task by ${name}`,
        status: 'Todo',
        assignedToUserId: null,
      });
    }

    const writes = ctx.prisma.callsFor('eventTask.create');
    expect(writes).toHaveLength(2);
    expect(writes[0].data.deadline).toBeInstanceOf(Date);
  });

  it('lets a Department Head create a schedule entry (201) with the parsed times', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'head');

    const res = await request(ctx.app.getHttpServer())
      .post(SCHEDULE_URL)
      .set('Authorization', bearer)
      .send({
        activityName: 'Opening ceremony',
        startTime: '2026-05-01T09:00:00.000Z',
        endTime: '2026-05-01T10:00:00.000Z',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      eventId: EVENT_ID,
      activityName: 'Opening ceremony',
    });
    expect(new Date(res.body.startTime).toISOString()).toBe(
      '2026-05-01T09:00:00.000Z',
    );
    const write = ctx.prisma.callsFor('eventSchedule.create')[0];
    expect(write.data.startTime).toBeInstanceOf(Date);
    expect(write.data.endTime).toBeInstanceOf(Date);
  });

  it('refuses a non-owner Event Coordinator with 403 and writes nothing', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'Not allowed', deadline: '2026-05-01T12:00:00.000Z' })
      .expect(403);

    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventTask.create')).toBe(false);
  });

  it('lets the Event Coordinator who owns the event create a task (201)', async () => {
    scriptEvent(ctx, { createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'coordinator');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'Owner task', deadline: '2026-05-01T12:00:00.000Z' })
      .expect(201);

    expect(res.body.title).toBe('Owner task');
    expect(ctx.prisma.has('eventTask.create')).toBe(true);
  });

  it('lets a committee member of the event create a task (201) after the membership lookup', async () => {
    scriptEvent(ctx, { createdById: ACTORS.admin.sub });
    ctx.prisma.on('committeeMember.findFirst', {
      id: 'member-1',
      committeeId: 'cmte-1',
      userId: ACTORS.instructor.sub,
    });
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'Member task', deadline: '2026-05-01T12:00:00.000Z' })
      .expect(201);

    expect(res.body.title).toBe('Member task');
    expect(ctx.prisma.callsFor('committeeMember.findFirst')[0]).toMatchObject({
      where: {
        userId: ACTORS.instructor.sub,
        committee: { eventId: EVENT_ID },
      },
    });
  });

  it('refuses a Student with 403 when no membership exists', async () => {
    scriptEvent(ctx, { createdById: ACTORS.coordinator.sub });
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'Student task', deadline: '2026-05-01T12:00:00.000Z' })
      .expect(403);

    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.callsFor('committeeMember.findFirst')[0]).toMatchObject({
      where: { userId: ACTORS.student.sub },
    });
    expect(ctx.prisma.has('eventTask.create')).toBe(false);
  });

  it('refuses a task on a Cancelled event (409) with the exact gate message', async () => {
    scriptEvent(ctx, { status: 'Cancelled' });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'Too late', deadline: '2026-05-01T12:00:00.000Z' })
      .expect(409);

    expect(res.body.message).toBe(
      'Task and schedule operations are not allowed when event status is Cancelled',
    );
    expect(ctx.prisma.has('eventTask.create')).toBe(false);
  });

  it('refuses a schedule entry on a Rejected event (409) with the exact gate message', async () => {
    scriptEvent(ctx, { status: 'Rejected' });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(SCHEDULE_URL)
      .set('Authorization', bearer)
      .send({
        activityName: 'Never happened',
        startTime: '2026-05-01T09:00:00.000Z',
        endTime: '2026-05-01T10:00:00.000Z',
      })
      .expect(409);

    expect(res.body.message).toBe(
      'Task and schedule operations are not allowed when event status is Rejected',
    );
    expect(ctx.prisma.has('eventSchedule.create')).toBe(false);
  });

  it('returns 404 Event not found for an unknown event id', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .get(TASKS_URL)
      .set('Authorization', bearer)
      .expect(404);

    expect(res.body.message).toBe('Event not found');
    expect(ctx.prisma.has('eventTask.findMany')).toBe(false);
  });

  it('updates an existing task (200) and writes only the given fields', async () => {
    scriptEvent(ctx);
    ctx.prisma.on('eventTask.findFirst', {
      id: TASK_ID,
      eventId: EVENT_ID,
      title: 'Old title',
      assignedToUserId: null,
    });
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .patch(`${TASKS_URL}/${TASK_ID}`)
      .set('Authorization', bearer)
      .send({ status: 'Done' })
      .expect(200);

    expect(res.body).toMatchObject({ id: TASK_ID, status: 'Done' });
    expect(ctx.prisma.callsFor('eventTask.update')[0]).toMatchObject({
      where: { id: TASK_ID },
      data: { status: 'Done' },
    });
  });

  it('returns 404 Task not found when updating an unknown task', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .patch(`${TASKS_URL}/task-missing`)
      .set('Authorization', bearer)
      .send({ status: 'Done' })
      .expect(404);

    expect(res.body.message).toBe('Task not found');
    expect(ctx.prisma.has('eventTask.update')).toBe(false);
  });

  it('returns 404 Task not found when deleting an unknown task', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${TASKS_URL}/task-missing`)
      .set('Authorization', bearer)
      .expect(404);

    expect(res.body.message).toBe('Task not found');
    expect(ctx.prisma.has('eventTask.delete')).toBe(false);
  });

  it('refuses an Instructor without membership updating a task with 403 from the service and writes nothing', async () => {
    // F6 denial test: assertCanManagePlanning is owner/committee-member
    // dynamic, so a static @Roles would over-restrict — pin the service check.
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .patch(`${TASKS_URL}/${TASK_ID}`)
      .set('Authorization', bearer)
      .send({ status: 'Done' })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventTask.findFirst')).toBe(false);
    expect(ctx.prisma.has('eventTask.update')).toBe(false);
  });

  it('refuses a Student deleting a task with 403 from the service and deletes nothing', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${TASKS_URL}/${TASK_ID}`)
      .set('Authorization', bearer)
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventTask.delete')).toBe(false);
  });

  it('returns 404 Schedule entry not found when updating an unknown entry', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .patch(`${SCHEDULE_URL}/sched-missing`)
      .set('Authorization', bearer)
      .send({ activityName: 'Renamed' })
      .expect(404);

    expect(res.body.message).toBe('Schedule entry not found');
    expect(ctx.prisma.has('eventSchedule.update')).toBe(false);
  });

  it('rejects a task body without a deadline at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({ title: 'No deadline' })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('deadline');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('rejects a schedule body with a malformed time at the validation pipe (400) without reaching the service', async () => {
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(SCHEDULE_URL)
      .set('Authorization', bearer)
      .send({
        activityName: 'Broken',
        startTime: 'yesterday-ish',
        endTime: '2026-05-01T10:00:00.000Z',
      })
      .expect(400);

    expect(res.body.statusCode).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('startTime');
    expect(ctx.prisma.has('event.findUnique')).toBe(false);
  });

  it('rejects a schedule entry whose endTime is not after startTime (400) from the service', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin');

    const res = await request(ctx.app.getHttpServer())
      .post(SCHEDULE_URL)
      .set('Authorization', bearer)
      .send({
        activityName: 'Backwards',
        startTime: '2026-05-01T10:00:00.000Z',
        endTime: '2026-05-01T09:00:00.000Z',
      })
      .expect(400);

    expect(res.body.message).toBe('endTime must be after startTime');
    expect(ctx.prisma.has('eventSchedule.create')).toBe(false);
  });

  it('refuses a Student creating a schedule entry with 403 from the service and writes nothing', async () => {
    // F6 denial test: same dynamic planning-access rule as tasks — a static
    // @Roles would be vacuous, so the service check is pinned here instead.
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .post(SCHEDULE_URL)
      .set('Authorization', bearer)
      .send({
        activityName: 'Student activity',
        startTime: '2026-05-01T09:00:00.000Z',
        endTime: '2026-05-01T10:00:00.000Z',
      })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventSchedule.create')).toBe(false);
  });

  it('refuses an Instructor without membership updating a schedule entry with 403 from the service and writes nothing', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'instructor');

    const res = await request(ctx.app.getHttpServer())
      .patch(`${SCHEDULE_URL}/${SCHEDULE_ID}`)
      .set('Authorization', bearer)
      .send({ activityName: 'Renamed by nobody' })
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventSchedule.findFirst')).toBe(false);
    expect(ctx.prisma.has('eventSchedule.update')).toBe(false);
  });

  it('refuses a Student deleting a schedule entry with 403 from the service and deletes nothing', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const res = await request(ctx.app.getHttpServer())
      .delete(`${SCHEDULE_URL}/${SCHEDULE_ID}`)
      .set('Authorization', bearer)
      .expect(403);

    expect(res.body.statusCode).toBe(403);
    expect(res.body.message).toBe(MANAGE_DENIED);
    expect(ctx.prisma.has('eventSchedule.delete')).toBe(false);
  });

  it('notifies the assignee when a task is created with an assignee', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'admin', {
      'u-assignee': { id: 'u-assignee' },
    });

    const res = await request(ctx.app.getHttpServer())
      .post(TASKS_URL)
      .set('Authorization', bearer)
      .send({
        title: 'Assigned task',
        deadline: '2026-05-01T12:00:00.000Z',
        assignedToUserId: 'u-assignee',
      })
      .expect(201);

    expect(res.body.assignedToUserId).toBe('u-assignee');
    const notifications = ctx.prisma.callsFor('notification.createMany');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data[0]).toMatchObject({
      userId: 'u-assignee',
      eventId: EVENT_ID,
      type: 'TaskAssigned',
      message: 'You have been assigned task "Assigned task"',
    });
  });

  it('lets any authenticated caller read tasks and schedule (no Roles decorator on GET)', async () => {
    scriptEvent(ctx);
    const bearer = await bearerFor(ctx, 'student');

    const tasks = await request(ctx.app.getHttpServer())
      .get(TASKS_URL)
      .set('Authorization', bearer)
      .expect(200);
    expect(tasks.body).toEqual([]);

    const schedule = await request(ctx.app.getHttpServer())
      .get(SCHEDULE_URL)
      .set('Authorization', bearer)
      .expect(200);
    expect(schedule.body).toEqual([]);
  });
});

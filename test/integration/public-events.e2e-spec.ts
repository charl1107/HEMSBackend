/**
 * HTTP integration tests for the public catalog (/public/events) through the
 * real app stack with the database mocked. No Postgres connection is opened.
 *
 * The routes are annotated `@Public()`, so they must answer without any
 * token. The status filter (`Planning | Ongoing | Completed`) is
 * pushed into SQL by `EventsService.findPublicMany` / `findPublicOne`
 * (`where.status = { in: PUBLIC_EVENT_STATUSES }`), and the in-memory fake
 * never executes SQL — so each test asserts the `where` argument handed to
 * Prisma instead of relying on the payload, which the fake cannot filter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from '../support/harness.js';

const PUBLIC_STATUSES = ['Planning', 'Ongoing', 'Completed'];

function publicEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-public',
    title: 'Open Day',
    description: 'Campus open day',
    eventDate: '2026-06-01T00:00:00.000Z',
    venue: 'Main Hall',
    department: 'Computer Science',
    campusScope: 'OnCampus',
    status: 'Planning',
    eventTypeId: null,
    eventType: null,
    createdById: 'u-coord',
    ...overrides,
  };
}

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sch-1',
    eventId: 'ev-public',
    activityName: 'Opening ceremony',
    startTime: '2026-06-01T09:00:00.000Z',
    endTime: '2026-06-01T10:00:00.000Z',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Public events catalog (mocked database)', () => {
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

  it('GET /public/events answers 200 without a token and filters statuses in SQL', async () => {
    ctx.prisma.on('event.findMany', [publicEventRow()]);
    ctx.prisma.on('event.count', 1);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events')
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Open Day');

    // The public-status filter is applied by the query, not by the payload:
    // the fake returns whatever it was given, so assert the `where`.
    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    expect(findMany.where.status.in).toEqual(PUBLIC_STATUSES);
    expect(findMany.take).toBe(100);
    expect(ctx.prisma.callsFor('event.count')[0]).toEqual({ where: findMany.where });

    // Public means public: no identity is resolved for the caller at all.
    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('a caller asking for status=Cancelled cannot widen the public filter', async () => {
    ctx.prisma.on('event.findMany', []);

    await request(ctx.app.getHttpServer())
      .get('/public/events?status=Cancelled')
      .expect(200);

    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    // The public base filter is always the first AND clause, so a caller can
    // only ever narrow inside it — Cancelled never escapes.
    expect(findMany.where.AND[0]).toEqual({ status: { in: PUBLIC_STATUSES } });
    // The controller imports `EventListQueryDto` as a value, so the global
    // ValidationPipe runs @Transform/@IsIn and `Cancelled` reaches the query as a
    // single-element array instead of being spread character-by-character.
    expect(findMany.where.AND[1]).toEqual({ status: { in: ['Cancelled'] } });
  });

  it('an unknown status filter is rejected exactly like GET /events: 400 naming the field', async () => {
    // Both routes share `EventListQueryDto`; now that the public controller
    // imports it as a value, `@IsIn` answers 400 before the service runs —
    // no `event.findMany` call, same as the authenticated route.
    const res = await request(ctx.app.getHttpServer())
      .get('/public/events?status=NotAStatus')
      .expect(400);

    expect(JSON.stringify(res.body)).toContain('status');
    expect(ctx.prisma.has('event.findMany')).toBe(false);
  });

  it('a limit above the @Max(500) cap is rejected, not forwarded to Prisma', async () => {
    // PageQueryDto enforces @Min(1)/@Max(500)/@Type(Number), so an
    // out-of-range `limit` answers 400 and the raw string never reaches
    // Prisma's `take` (see `?limit=0 returns 400` for the @Min side).
    await request(ctx.app.getHttpServer())
      .get('/public/events?limit=10000')
      .expect(400);

    expect(ctx.prisma.has('event.findMany')).toBe(false);
  });

  it('an invalid campusScope is rejected instead of being forwarded verbatim', async () => {
    // `@IsIn(EVENT_CAMPUS_SCOPES)` now runs on this route too, so an invalid
    // enum value can no longer reach Prisma (a real client would throw
    // PrismaClientValidationError => 500).
    await request(ctx.app.getHttpServer())
      .get('/public/events?campusScope=Teleport')
      .expect(400);

    expect(ctx.prisma.has('event.findMany')).toBe(false);
  });

  it('passes pagination and campus scope through to the query alongside the status filter', async () => {
    ctx.prisma.on('event.findMany', []);

    await request(ctx.app.getHttpServer())
      .get('/public/events?limit=5&offset=10&campusScope=OffCampus')
      .expect(200);

    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    // The DTO now validates and coerces: limit/offset arrive as numbers
    // (@Type(Number)), campusScope passes @IsIn, and the public status base
    // filter stays the first AND clause.
    expect(findMany.take).toBe(5);
    expect(findMany.skip).toBe(10);
    expect(findMany.where).toEqual({
      AND: [
        { status: { in: PUBLIC_STATUSES } },
        { campusScope: 'OffCampus' },
      ],
    });
  });

  // --- Query validation & forwarding (F16 / F35) ----------------------------
  // Before the fix this controller imported `EventListQueryDto` with
  // `import type`, so `emitDecoratorMetadata` could not reference the class
  // and the global ValidationPipe skipped the query entirely: no @Type
  // coercion, no @Min/@Max, no @IsIn. These tests pin the corrected contract.

  it('?limit=1 returns exactly 1 item', async () => {
    const rows = [
      publicEventRow(),
      publicEventRow({ id: 'ev-2', title: 'Spring Fair' }),
    ];
    // The fake never applies `take` itself — model Prisma's slicing, but only
    // when the DTO handed over a real number (a raw query string arrives as
    // '1' and the fake hands back the full set, exactly as an unvalidated
    // route would forward it).
    ctx.prisma.on('event.findMany', (args: any) =>
      typeof args.take === 'number' ? rows.slice(0, args.take) : rows,
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events?limit=1')
      .expect(200);

    const body = res.body.items;
    expect(body).toHaveLength(1);

    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    expect(findMany.take).toBe(1);
  });

  it('?offset=1 skips the first item', async () => {
    const rows = [
      publicEventRow(),
      publicEventRow({ id: 'ev-2', title: 'Spring Fair' }),
    ];
    ctx.prisma.on('event.findMany', (args: any) =>
      typeof args.skip === 'number' ? rows.slice(args.skip) : rows,
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events?offset=1')
      .expect(200);

    const body = res.body.items;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('ev-2');

    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    expect(findMany.skip).toBe(1);
  });

  it('?status=Bogus returns 400', async () => {
    await request(ctx.app.getHttpServer())
      .get('/public/events?status=Bogus')
      .expect(400);

    // Rejected by the ValidationPipe: the service is never reached.
    expect(ctx.prisma.has('event.findMany')).toBe(false);
  });

  it('?limit=0 returns 400', async () => {
    // PageQueryDto.limit is @Min(1), so 0 is rejected here exactly as it is
    // on GET /events — no string '0' is ever handed to Prisma's `take`.
    await request(ctx.app.getHttpServer())
      .get('/public/events?limit=0')
      .expect(400);

    expect(ctx.prisma.has('event.findMany')).toBe(false);
  });

  it('GET /public/events/:id answers 200 without a token', async () => {
    ctx.prisma.on('event.findFirst', publicEventRow());

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-public')
      .expect(200);

    expect(res.body).toMatchObject({ id: 'ev-public', title: 'Open Day' });

    const findFirst = ctx.prisma.callsFor('event.findFirst')[0] as any;
    expect(findFirst.where).toEqual({
      id: 'ev-public',
      status: { in: PUBLIC_STATUSES },
    });
  });

  it('GET /public/events/:id for a hidden or unknown event => 404', async () => {
    // `findFirst` is filtered by status in SQL, so a Cancelled
    // event (or a missing one) comes back null and the service answers 404.
    ctx.prisma.on('event.findFirst', null);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-hidden')
      .expect(404);

    expect(res.body.message).toBe('Event not found');

    const findFirst = ctx.prisma.callsFor('event.findFirst')[0] as any;
    expect(findFirst.where.id).toBe('ev-hidden');
    expect(findFirst.where.status.in).toEqual(PUBLIC_STATUSES);
  });

  it('a garbage bearer token is ignored: the route never validates identity', async () => {
    ctx.prisma.on('event.findMany', []);

    await request(ctx.app.getHttpServer())
      .get('/public/events')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(200);

    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('the public list never runs the authenticated visibility filter', async () => {
    ctx.prisma.on('event.findMany', []);

    await request(ctx.app.getHttpServer())
      .get('/public/events')
      .expect(200);

    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    // An authenticated /events query would carry `OR: [...]` for non-reviewers
    // or `createdById` scoping; the public one is a bare status filter.
    expect(findMany.where.OR).toBeUndefined();
    expect(findMany.where.createdById).toBeUndefined();
    expect(findMany.where.status.in).toEqual(PUBLIC_STATUSES);
  });

  // --- F18: public responses carry only the fields the public UI renders ------
  // Step 1 derivation: every event field read by
  // `frontend/src/views/public/PublicEventListView.vue` (id, title, venue,
  // description, status, eventDate, coverImageUrl) and
  // `frontend/src/views/public/PublicEventDetailView.vue` (+ eventType.name,
  // rendered by `EventCard`/`StatusBadge` props). The plan's candidate
  // `endDate` has no column on the Prisma Event model at all, and
  // campusScope / department / createdAt / updatedAt / eventTypeId are never
  // read on a public page (EventCard only receives them from authenticated
  // views) — so none of them may leave the server. `status` and `id` stay:
  // the status gate, the badge and the detail link need them.
  const PUBLIC_EVENT_FIELDS = [
    'id',
    'title',
    'description',
    'eventDate',
    'venue',
    'coverImageUrl',
    'status',
    'eventType',
  ] as const;

  /**
   * The in-memory fake Prisma ignores `select` (see test/support/fake-prisma.ts),
   * so this hands a scripted row back the way the real client does: a query
   * without `select` returns the whole row — today's over-exposure — while a
   * query that asks for a subset returns only the requested keys, relation
   * selects included. F18 lives or dies on that difference, which is what
   * makes the body assertions below fail before the fix.
   */
  function projectRow(row: Record<string, unknown>, select: unknown): unknown {
    if (!select || typeof select !== 'object') return row;
    const picks = select as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, wanted] of Object.entries(picks)) {
      if (!wanted) continue;
      const value = row[key];
      if (wanted === true || value === null || value === undefined) {
        out[key] = value;
      } else if (typeof wanted === 'object' && typeof value === 'object') {
        out[key] = projectRow(
          value as Record<string, unknown>,
          (wanted as { select?: unknown }).select,
        );
      }
    }
    return out;
  }

  /** A full public row: every column the exposure leak used to carry. */
  function publicFullRow(overrides: Record<string, unknown> = {}) {
    return publicEventRow({
      coverImageUrl: '/covers/open-day.png',
      eventType: { id: 't-fair', name: 'Fair' },
      ...overrides,
    });
  }

  function expectPublicEventShape(body: Record<string, unknown>): void {
    expect(body).not.toHaveProperty('createdById');
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_EVENT_FIELDS].sort());
    // No internal `*Id` survives the projection — `id` is the only one allowed.
    expect(
      Object.keys(body).filter((key) => key.endsWith('Id') && key !== 'id'),
    ).toEqual([]);
    // eventType ships as the relation the detail page renders, not the row.
    expect(body.eventType).toEqual({ name: 'Fair' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('u-coord');
    expect(raw).not.toContain('eventTypeId');
  }

  it('F18: GET /public/events returns only the fields the public list renders', async () => {
    ctx.prisma.on('event.findMany', (args: any) => [
      projectRow(publicFullRow(), args?.select),
    ]);
    ctx.prisma.on('event.count', 1);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events')
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expectPublicEventShape(res.body.items[0]);

    // The row is no longer fetched whole: the query asks for the subset.
    const findMany = ctx.prisma.callsFor('event.findMany')[0] as any;
    expect(findMany.select).toBeDefined();
    expect(findMany.include).toBeUndefined();
  });

  it('F18: GET /public/events/:id returns only the fields the public detail renders', async () => {
    ctx.prisma.on('event.findFirst', (args: any) =>
      projectRow(publicFullRow(), args?.select),
    );

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-public')
      .expect(200);

    expectPublicEventShape(res.body);

    // Same gate as before, but the detail row is projected too.
    const findFirst = ctx.prisma.callsFor('event.findFirst')[0] as any;
    expect(findFirst.where).toEqual({
      id: 'ev-public',
      status: { in: PUBLIC_STATUSES },
    });
    expect(findFirst.select).toBeDefined();
    expect(findFirst.include).toBeUndefined();
  });

  // --- F31: public schedule route ------------------------------------------
  // The public detail page reads the schedule anonymously, so the route has to
  // pass the exact same status gate as `findPublicOne`: the filter lives in
  // SQL, and a Cancelled or missing event answers 404 before a
  // single schedule row is read.

  it('GET /public/events/:id/schedule answers 200 without a token and gates on the public statuses in SQL', async () => {
    ctx.prisma.on('event.findFirst', publicEventRow());
    ctx.prisma.on('eventSchedule.findMany', [scheduleRow()]);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-public/schedule')
      .expect(200);

    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({
      id: 'sch-1',
      eventId: 'ev-public',
      activityName: 'Opening ceremony',
      startTime: '2026-06-01T09:00:00.000Z',
      endTime: '2026-06-01T10:00:00.000Z',
    });

    // Same gate as findPublicOne: the status filter is handed to SQL.
    const findFirst = ctx.prisma.callsFor('event.findFirst')[0] as any;
    expect(findFirst.where).toEqual({
      id: 'ev-public',
      status: { in: PUBLIC_STATUSES },
    });

    const findMany = ctx.prisma.callsFor('eventSchedule.findMany')[0] as any;
    expect(findMany.where).toEqual({ eventId: 'ev-public' });
    expect(findMany.orderBy).toEqual({ startTime: 'asc' });

    // Public means public: no identity is resolved for the caller at all.
    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('GET /public/events/:id/schedule for a Cancelled event => 404 without reading the schedule', async () => {
    // The fake never applies the WHERE itself, so a Cancelled row is modelled
    // the way SQL sees it: the status gate makes `findFirst` come back empty.
    ctx.prisma.on('event.findFirst', null);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-cancelled/schedule')
      .expect(404);

    expect(res.body.message).toBe('Event not found');

    const findFirst = ctx.prisma.callsFor('event.findFirst')[0] as any;
    expect(findFirst.where.id).toBe('ev-cancelled');
    expect(findFirst.where.status.in).toEqual(PUBLIC_STATUSES);

    // The gate runs first: a hidden event never reaches the schedule table.
    expect(ctx.prisma.has('eventSchedule.findMany')).toBe(false);
  });

  it('GET /public/events/:id/schedule for an unknown id => 404', async () => {
    ctx.prisma.on('event.findFirst', null);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/no-such-event/schedule')
      .expect(404);

    expect(res.body.message).toBe('Event not found');
    expect(ctx.prisma.has('eventSchedule.findMany')).toBe(false);
  });

  it('the public schedule response carries schedule rows only, never event fields', async () => {
    // The fake ignores `select`, so the gate lookup hands back the full event
    // row — createdById and friends included. None of it may reach the client.
    ctx.prisma.on('event.findFirst', publicEventRow({ createdById: 'u-coord' }));
    ctx.prisma.on('eventSchedule.findMany', [scheduleRow()]);

    const res = await request(ctx.app.getHttpServer())
      .get('/public/events/ev-public/schedule')
      .expect(200);

    expect(Object.keys(res.body)).toEqual(['items']);
    expect(res.body.items[0]).toEqual(scheduleRow());
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('createdById');
    expect(raw).not.toContain('u-coord');
    expect(raw).not.toContain('reviewer');
    expect(raw).not.toContain('createdBy');
  });
});

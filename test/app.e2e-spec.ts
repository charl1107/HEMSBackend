/**
 * App-level smoke tests.
 *
 * The database layer is the in-memory fake (see `test/support/fake-prisma.ts`),
 * so booting the full AppModule here cannot open a Postgres connection — the
 * live Supabase database is never reached, even though `GET /health` runs a
 * `SELECT 1` in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './support/harness.js';

describe('App (e2e, mocked database)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('/ (GET) responds 200', () =>
    request(ctx.app.getHttpServer()).get('/').expect(200).expect('Hello World!'));

  it('/health (GET) is public and reports db up from the fake, without a token', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'up' });
    // Proof the health check answered from the mock: it was routed to the
    // fake client, not to a database connection.
    expect(ctx.prisma.callsFor('$queryRaw')).toHaveLength(1);
  });

  it('answers health from the mock when the query fails, still without a token', async () => {
    ctx.prisma.reset();
    ctx.prisma.on('$queryRaw', () => {
      throw new Error('connection refused (mocked)');
    });

    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'down' });
  });
});

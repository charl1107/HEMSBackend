/**
 * HTTP integration tests for GET /health through the real app stack with the
 * database mocked. The endpoint is `@Public()`: it must answer 200 without an
 * Authorization header (or with a garbage one) and report the database state
 * it reads from the fake Prisma client.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from '../support/harness.js';

describe('GET /health (mocked database)', () => {
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

  it('answers 200 { status: ok, db: up } without any Authorization header', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'up' });
    // Proof the check was served by the fake client: exactly one $queryRaw.
    expect(ctx.prisma.callsFor('$queryRaw')).toHaveLength(1);
    // And no user was ever resolved — no authentication took place.
    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('stays public even when a garbage bearer token is supplied', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/health')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'up' });
    // The public short-circuit means passport never ran for this request.
    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('reports { status: ok, db: down } with 200 when the connection check fails', async () => {
    ctx.prisma.on('$queryRaw', () => {
      throw new Error('connection refused (mocked)');
    });

    const res = await request(ctx.app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toEqual({ status: 'ok', db: 'down' });
    expect(ctx.prisma.has('$queryRaw')).toBe(true);
    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });
});

/**
 * HTTP integration tests for /auth through the real app stack
 * (global JWT guard + roles guard + throttler + validation + audit interceptor)
 * with the database mocked. No Postgres connection is opened.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { createTestApp, ACTORS, userRowFor, type TestApp } from '../support/harness.js';

const PASSWORD = 'Sup3rSecret!';

function credentialRow(actorName: keyof typeof ACTORS, overrides: Record<string, unknown> = {}) {
  const row = userRowFor(actorName);
  return {
    ...row,
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    mustChangePassword: false,
    ...overrides,
  };
}

describe('POST /auth/login (mocked database)', () => {
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

  it('returns an access token and sets the refresh cookie for valid credentials', async () => {
    ctx.prisma.on('user.findUnique', credentialRow('student'));

    const res = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: ACTORS.student.email, password: PASSWORD })
      .expect(200);

    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.accessToken.split('.')).toHaveLength(3);
    expect(res.body.user.email).toBe(ACTORS.student.email);
    // SafeUser must never leak the hash or id-of-internal-fields it denylists.
    expect(res.body.user).not.toHaveProperty('passwordHash');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).join('; ');
    expect(cookie).toContain('refresh_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/auth');
    expect(ctx.prisma.has('refreshToken.create')).toBe(true);
  });

  it('rejects a wrong password with 401 and does not issue a session', async () => {
    ctx.prisma.on('user.findUnique', credentialRow('student'));

    const res = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: ACTORS.student.email, password: 'not-the-password' })
      .expect(401);

    expect(res.body.message).toBe('Invalid credentials');
    expect(ctx.prisma.has('refreshToken.create')).toBe(false);
  });

  it('rejects an unknown account with 401', async () => {
    ctx.prisma.on('user.findUnique', null);

    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@hems.local', password: PASSWORD })
      .expect(401);
  });

  it('rejects a deactivated account with 401', async () => {
    ctx.prisma.on('user.findUnique', credentialRow('student', { isActive: false }));

    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: ACTORS.student.email, password: PASSWORD })
      .expect(401);
  });

  it('rejects a malformed body with 400 instead of reaching the service', async () => {
    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'not-an-email' })
      .expect(400);

    expect(ctx.prisma.has('user.findUnique')).toBe(false);
  });

  it('answers identically for an unknown account and a wrong password (no user enumeration)', async () => {
    ctx.prisma.on('user.findUnique', null);
    const unknownAccount = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@hems.local', password: PASSWORD })
      .expect(401);

    ctx.prisma.on('user.findUnique', credentialRow('student'));
    const wrongPassword = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: ACTORS.student.email, password: 'definitely-wrong' })
      .expect(401);

    expect(unknownAccount.body).toEqual(wrongPassword.body);
    expect(unknownAccount.body.message).toBe('Invalid credentials');
    expect(JSON.stringify(unknownAccount.body)).not.toMatch(/password|hash|exists/i);
  });

});

// Its own app: the throttler counter is per-instance and shared across every
// login attempt, so it must not inherit the attempts made by the suite above.
describe('POST /auth/login rate limiting (mocked database)', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
    ctx.prisma.on('user.findUnique', null);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('allows exactly 10 attempts per minute, then returns 429', async () => {
    const body = { email: ACTORS.student.email, password: PASSWORD };

    for (let i = 0; i < 10; i += 1) {
      await request(ctx.app.getHttpServer()).post('/auth/login').send(body).expect(401);
    }

    const blocked = await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(429);

    expect(blocked.body.message).toMatch(/throttl|too many/i);
    expect(ctx.prisma.callsFor('user.findUnique')).toHaveLength(10);
  });

  it('counts rejected attempts against the same budget', async () => {
    // The 11th call above already exhausted the window; a *valid* credential
    // must still be blocked, proving the limit is per-IP not per-success.
    ctx.prisma.on('user.findUnique', credentialRow('student'));

    await request(ctx.app.getHttpServer())
      .post('/auth/login')
      .send({ email: ACTORS.student.email, password: PASSWORD })
      .expect(429);
  });
});

describe('JWT guard stack (mocked database)', () => {
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

  it('rejects a protected route without a token', async () => {
    await request(ctx.app.getHttpServer()).get('/events').expect(401);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const { JwtService } = await import('@nestjs/jwt');
    const bogus = new JwtService({ secret: 'attacker-secret', signOptions: { expiresIn: '15m' } });
    const token = await bogus.signAsync({ sub: ACTORS.admin.sub, email: ACTORS.admin.email });

    await request(ctx.app.getHttpServer())
      .get('/events')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a garbage bearer token', async () => {
    await request(ctx.app.getHttpServer())
      .get('/events')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('rejects a token whose subject no longer exists', async () => {
    ctx.prisma.on('user.findUnique', null);
    const token = await ctx.sign({ sub: 'ghost', email: 'ghost@hems.local' });

    await request(ctx.app.getHttpServer())
      .get('/events')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a token for a deactivated user', async () => {
    ctx.prisma.on('user.findUnique', { ...userRowFor('admin'), isActive: false });
    const token = await ctx.sign({ sub: ACTORS.admin.sub, email: ACTORS.admin.email });

    await request(ctx.app.getHttpServer())
      .get('/events')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('lets an authenticated caller through and reports the caller on /auth/me', async () => {
    ctx.prisma.on('user.findUnique', userRowFor('student'));
    const bearer = await ctx.bearer({
      sub: ACTORS.student.sub,
      email: ACTORS.student.email,
    });

    const res = await request(ctx.app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', bearer)
      .expect(200);

    expect(res.body.email).toBe(ACTORS.student.email);
    expect(res.body.roles).toEqual(['Student']);
  });
});

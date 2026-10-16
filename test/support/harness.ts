/**
 * Shared HTTP test harness.
 *
 * Boots the real application (AppModule: global JWT guard, roles guard,
 * throttler, audit interceptor, validation pipe, helmet, CORS, cookies) but
 * swaps `PrismaService` for the in-memory fake, so every request is handled
 * end-to-end while the database layer is a mock. Nothing here opens a socket
 * to Postgres.
 *
 *   const { app, prisma, auth } = await createTestApp();
 *   const res = await request(app.getHttpServer())
 *     .get('/events')
 *     .set('Authorization', await auth.asAdmin());
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { hardenApp } from '../../src/security.js';
import { resolveJwtSecret } from '../../src/auth/jwt-secret.js';
import { createFakePrisma, type FakePrisma } from './fake-prisma.js';

// AuthModule resolves JWT_SECRET at AppModule compile time and rejects
// missing/placeholder values in every environment, so the e2e suite needs a
// deterministic non-placeholder secret without depending on the developer's
// shell. A real .env value always wins.
process.env.JWT_SECRET ??= 'e2e-only-secret-not-for-production';

export interface TestApp {
  app: INestApplication;
  prisma: FakePrisma;
  /** Signs access tokens exactly the way the API does, for `Authorization` headers. */
  sign: (claims: { sub: string; email: string }) => Promise<string>;
  bearer: (claims: { sub: string; email: string }) => Promise<string>;
  close: () => Promise<void>;
}

/** Well-known actors used across the HTTP suites. */
export const ACTORS = {
  admin: { sub: 'u-admin', email: 'admin@hems.local', roles: ['Admin'] },
  head: { sub: 'u-head', email: 'head@hems.local', roles: ['Department Head'] },
  coordinator: {
    sub: 'u-coord',
    email: 'coord@hems.local',
    roles: ['Event Coordinator'],
  },
  instructor: {
    sub: 'u-inst',
    email: 'inst@hems.local',
    roles: ['Instructor'],
  },
  officer: { sub: 'u-officer', email: 'officer@hems.local', roles: ['Student Officer'] },
  student: { sub: 'u-student', email: 'student@hems.local', roles: ['Student'] },
} as const;

export type ActorName = keyof typeof ACTORS;

/** Rows the JWT strategy expects when it resolves the caller. */
export function userRowFor(actorName: ActorName): Record<string, unknown> {
  const actor = ACTORS[actorName];
  return {
    id: actor.sub,
    email: actor.email,
    firstName: actor.email.split('@')[0],
    lastName: 'Tester',
    isActive: true,
    mustChangePassword: false,
    userRoles: actor.roles.map((name, index) => ({
      id: `ur-${actorName}-${index}`,
      role: { id: `role-${name}`, name },
    })),
  };
}

export async function createTestApp(): Promise<TestApp> {
  const prisma = createFakePrisma();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The real client is never constructed: the fake answers every query.
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();

  const app = moduleRef.createNestApplication();
  // Same middleware stack as src/main.ts, with deterministic test env values.
  hardenApp(app, {
    FRONTEND_URL: 'http://localhost:5173',
    NODE_ENV: 'test',
  });
  await app.init();

  const secret = resolveJwtSecret(moduleRef.get(ConfigService, { strict: false }));
  const jwt = new JwtService({ secret, signOptions: { expiresIn: '15m' } });

  const sign = (claims: { sub: string; email: string }) =>
    jwt.signAsync({ ...claims });

  return {
    app,
    prisma,
    sign,
    bearer: async (claims) => `Bearer ${await sign(claims)}`,
    close: async () => {
      await app.close();
      await moduleRef.close();
    },
  };
}

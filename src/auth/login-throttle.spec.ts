import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

describe('POST /auth/login rate limiting', () => {
  let app: INestApplication;
  const login = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', limit: 10, ttl: 60_000, blockDuration: 60_000 },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: { login } },
        // Mirrors AppModule: the global guard enforces @Throttle on login.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    login.mockReset();
    login.mockResolvedValue({
      accessToken: 'token',
      user: { id: 'u1', email: 'user@example.com', name: 'User', roles: [] },
    });
  });

  it('allows 10 requests per minute then returns 429', async () => {
    const body = { email: 'user@example.com', password: 'secret' };
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send(body)
        .expect(200);
    }
    await request(app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(429);
    expect(login).toHaveBeenCalledTimes(10);
  });
});

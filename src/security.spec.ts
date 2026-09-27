import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { IsEmail, IsString } from 'class-validator';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { hardenApp, resolveCorsOptions } from './security.js';

describe('resolveCorsOptions', () => {
  it('parses a comma-separated FRONTEND_URL allowlist', () => {
    expect(
      resolveCorsOptions({
        FRONTEND_URL: 'https://app.example.com, https://admin.example.com',
      }),
    ).toEqual({
      origin: ['https://app.example.com', 'https://admin.example.com'],
      credentials: true,
    });
  });

  it('throws when the allowlist contains a wildcard', () => {
    expect(() => resolveCorsOptions({ FRONTEND_URL: '*' })).toThrow(/\*/);
    expect(() =>
      resolveCorsOptions({ FRONTEND_URL: 'https://a.example.com,*' }),
    ).toThrow(/\*/);
  });

  it('throws in production when FRONTEND_URL is missing or empty', () => {
    expect(() => resolveCorsOptions({ NODE_ENV: 'production' })).toThrow(
      /FRONTEND_URL/,
    );
    expect(() =>
      resolveCorsOptions({ NODE_ENV: 'production', FRONTEND_URL: ' , ' }),
    ).toThrow(/FRONTEND_URL/);
  });

  it('disables CORS outside production when FRONTEND_URL is unset', () => {
    expect(resolveCorsOptions({})).toEqual({
      origin: false,
      credentials: false,
    });
  });
});

class EchoDto {
  @IsEmail()
  email!: string;

  @IsString()
  name!: string;
}

@Controller('hardening-echo')
class HardeningEchoController {
  @Post()
  create(@Body() dto: EchoDto) {
    return dto;
  }
}

describe('hardenApp', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HardeningEchoController],
    }).compile();
    app = moduleRef.createNestApplication();
    hardenApp(app, {
      FRONTEND_URL: 'https://app.example.com,https://admin.example.com',
      NODE_ENV: 'test',
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects invalid bodies via the global ValidationPipe', async () => {
    await request(app.getHttpServer())
      .post('/hardening-echo')
      .send({ email: 'not-an-email', name: 'x' })
      .expect(400);
  });

  it('strips properties not on the DTO (whitelist)', async () => {
    const res = await request(app.getHttpServer())
      .post('/hardening-echo')
      .send({ email: 'a@example.com', name: 'x', isAdmin: true })
      .expect(201);
    expect(res.body).toEqual({ email: 'a@example.com', name: 'x' });
  });

  it('allows origins on the FRONTEND_URL allowlist', async () => {
    const res = await request(app.getHttpServer())
      .get('/hardening-echo')
      .set('Origin', 'https://app.example.com')
      .expect(404);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.example.com',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('omits CORS headers for origins outside the allowlist', async () => {
    const res = await request(app.getHttpServer())
      .get('/hardening-echo')
      .set('Origin', 'https://evil.example.com')
      .expect(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers and hides X-Powered-By', async () => {
    const res = await request(app.getHttpServer())
      .get('/hardening-echo')
      .expect(404);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});

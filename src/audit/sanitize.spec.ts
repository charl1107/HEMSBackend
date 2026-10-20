import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuditService } from './audit.service.js';
import { sanitizeAuditBody } from './sanitize.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('audit denylist', () => {
  it('strips password, password_hash, passwordHash, token, refreshToken, authorization at top level', () => {
    const result = sanitizeAuditBody({
      email: 'admin@hems.local',
      password: 'secret',
      password_hash: 'bcrypt-hash',
      passwordHash: 'bcrypt-hash',
      token: 'abc',
      refreshToken: 'def',
      authorization: 'Bearer xyz',
    }) as Record<string, unknown>;

    expect(result).toEqual({ email: 'admin@hems.local' });
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('password_hash');
    expect(result).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('refreshToken');
    expect(result).not.toHaveProperty('authorization');
  });

  it('matches denylist keys case-insensitively', () => {
    const result = sanitizeAuditBody({
      Password: 'secret',
      TOKEN: 'abc',
      Refreshtoken: 'def',
      Authorization: 'Bearer xyz',
    });
    expect(result).toEqual({});
  });

  it('strips denylisted keys recursively in nested objects and arrays', () => {
    const result = sanitizeAuditBody({
      user: { email: 'a@b.c', password: 'secret' },
      items: [{ token: 'abc', name: 'kept' }],
    });

    expect(result).toEqual({
      user: { email: 'a@b.c' },
      items: [{ name: 'kept' }],
    });
  });

  it('keeps non-denylisted fields', () => {
    const body = { firstName: 'Demo', isActive: true, count: 3 };
    expect(sanitizeAuditBody(body)).toEqual(body);
  });

  it('strips pattern-matched keys regardless of spelling or case (F23)', () => {
    const result = sanitizeAuditBody({
      accessToken: 'a',
      Auth_Token: 'b',
      Secret: 'c',
      apiKey: 'd',
      OTP: 'e',
      pin: 'f',
      passwd: 'g',
      nested: { level2: { level3: { auth_token: 'h', label: 'kept' } } },
    });

    expect(result).toEqual({ nested: { level2: { level3: { label: 'kept' } } } });
  });
});

describe('AuditService', () => {
  let prisma: { auditLog: { create: ReturnType<typeof vi.fn> } };
  let service: AuditService;

  beforeEach(() => {
    prisma = { auditLog: { create: vi.fn().mockResolvedValue({}) } };
    service = new AuditService(prisma as unknown as PrismaService);
  });

  it('persists body with denylisted fields removed', async () => {
    await service.log({
      userId: 'u1',
      method: 'POST',
      path: '/auth/login',
      body: { email: 'admin@hems.local', password: 'secret' },
      statusCode: 200,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        method: 'POST',
        path: '/auth/login',
        body: { email: 'admin@hems.local' },
        statusCode: 200,
      },
    });
  });

  it('never throws when the audit write fails', async () => {
    prisma.auditLog.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.log({ method: 'POST', path: '/users', body: {} }),
    ).resolves.toBeUndefined();
  });

  it('logWith writes through the provided transaction client and sanitizes body', async () => {
    const tx = { auditLog: { create: vi.fn().mockResolvedValue({}) } };

    await service.logWith(tx, {
      userId: 'u1',
      method: 'POST',
      path: '/events/evt-1/approve',
      body: { overrideConflict: true, token: 'secret' },
      statusCode: 200,
    });

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        method: 'POST',
        path: '/events/evt-1/approve',
        body: { overrideConflict: true },
        statusCode: 200,
      },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('logWith propagates failure so a surrounding transaction rolls back', async () => {
    const tx = {
      auditLog: { create: vi.fn().mockRejectedValue(new Error('db down')) },
    };

    await expect(
      service.logWith(tx, { method: 'POST', path: '/events/evt-1/approve' }),
    ).rejects.toThrow('db down');
  });
});

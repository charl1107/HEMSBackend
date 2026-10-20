/**
 * Interceptor-level tests for F26: the audit denylist must be applied in
 * AuditInterceptor.record() — at the boundary, before AuditService.log — so
 * secret-bearing request bodies never reach the audit writer, no matter how
 * the key is spelled (accessToken vs token vs auth_token, apiKey, otp, pin…).
 */
import { describe, expect, it, vi } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor.js';
import type { AuditService } from './audit.service.js';

/** Drives intercept() through the success path with headers already sent. */
function recordRequest(body: unknown, originalUrl = '/users') {
  const log = vi.fn().mockResolvedValue(undefined);
  const interceptor = new AuditInterceptor({ log } as unknown as AuditService);

  const request = {
    method: 'POST',
    originalUrl,
    url: originalUrl,
    body,
  };
  const response = { headersSent: true, statusCode: 201 };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  const next: CallHandler = { handle: () => of({ id: 'u-audited' }) };

  return { log, interceptor, context, next };
}

describe('AuditInterceptor boundary sanitisation (F23/F26)', () => {
  it('removes every denylisted key from the audited payload, recursively to depth 4', async () => {
    const rawBody = {
      email: 'audit-me@hems.local',
      accessToken: 'access-token-value',
      auth_token: 'auth-token-value',
      secret: 'shhh',
      apiKey: 'api-key-value',
      otp: '123456',
      pin: '9999',
      password: 'Sup3rSecret!',
      nested: {
        level2: {
          level3: {
            refreshToken: 'refresh-token-value',
            label: 'kept',
          },
        },
      },
    };
    const { log, interceptor, context, next } = recordRequest(rawBody);

    await firstValueFrom(interceptor.intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as { body: Record<string, unknown> };
    const logged = entry.body;

    for (const key of [
      'accessToken',
      'auth_token',
      'secret',
      'apiKey',
      'otp',
      'pin',
      'password',
    ]) {
      expect(logged).not.toHaveProperty(key);
    }
    // Depth 4: refreshToken sits four levels down and must still be gone.
    expect(logged).not.toHaveProperty('nested.level2.level3.refreshToken');
    // …while its container and non-denylisted siblings survive.
    expect(logged).toEqual({
      email: 'audit-me@hems.local',
      nested: { level2: { level3: { label: 'kept' } } },
    });
  });

  it('sanitises the logged copy only — the raw request body is left intact', async () => {
    const rawBody = {
      password: 'Sup3rSecret!',
      nested: { level2: { level3: { refreshToken: 'rt' } } },
    };
    const { log, interceptor, context, next } = recordRequest(rawBody);

    await firstValueFrom(interceptor.intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    expect(rawBody).toHaveProperty('password', 'Sup3rSecret!');
    expect(rawBody.nested.level2.level3).toHaveProperty('refreshToken', 'rt');
  });

  // F23 follow-up: query strings (?token=…&otp=…) must never reach the log.
  it('strips the query string from the audited path', async () => {
    const { log, interceptor, context, next } = recordRequest(
      { action: 'noop' },
      '/events/x?token=secret-abc&otp=123456&page=2',
    );

    await firstValueFrom(interceptor.intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as { path: string };
    expect(entry.path).toBe('/events/x');
  });

  it('leaves a query-free path unchanged', async () => {
    const { log, interceptor, context, next } = recordRequest(
      { action: 'noop' },
      '/events/x',
    );

    await firstValueFrom(interceptor.intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as { path: string };
    expect(entry.path).toBe('/events/x');
  });

  it('never writes the query secret into any logged entry field', async () => {
    const { log, interceptor, context, next } = recordRequest(
      { action: 'noop' },
      '/events/x?token=secret-abc&otp=123456&page=2',
    );

    await firstValueFrom(interceptor.intercept(context, next));

    expect(log).toHaveBeenCalledTimes(1);
    const entry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(entry)).not.toContain('secret-abc');
    expect(String(entry.path)).not.toContain('secret-abc');
  });
});

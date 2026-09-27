import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { AuditService } from './audit.service.js';
import type { AuthUser } from '../common/auth-user.js';

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthUser }>();
    if (!AUDITED_METHODS.has(request.method)) {
      return next.handle();
    }
    const response = http.getResponse<Response>();
    return next.handle().pipe(
      tap({
        next: () => {
          if (response.headersSent) {
            this.record(request, response.statusCode);
            return;
          }
          response.once('finish', () =>
            this.record(request, response.statusCode),
          );
        },
        error: (err: unknown) =>
          this.record(
            request,
            typeof (err as { status?: number })?.status === 'number'
              ? (err as { status: number }).status
              : 500,
          ),
      }),
    );
  }

  private record(request: Request & { user?: AuthUser }, statusCode: number): void {
    void this.audit.log({
      userId: request.user?.userId ?? null,
      method: request.method,
      path: request.originalUrl ?? request.url,
      body: request.body,
      statusCode,
    });
  }
}

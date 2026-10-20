import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { sanitizeAuditBody } from './sanitize.js';
import type { AuditPage, AuditQueryDto } from './dto/audit-query.dto.js';

export interface AuditEntry {
  userId?: string | null;
  method: string;
  path: string;
  body?: unknown;
  statusCode?: number;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toData(entry) });
    } catch (error) {
      this.logger.warn(
        `Failed to write audit log for ${entry.method} ${entry.path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async logWith(
    client: Pick<PrismaService, 'auditLog'>,
    entry: AuditEntry,
  ): Promise<void> {
    await client.auditLog.create({ data: this.toData(entry) });
  }

  async list(query: AuditQueryDto): Promise<AuditPage> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const where = this.buildWhere(query);
    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        user: row.user,
        method: row.method,
        path: row.path,
        entity: entityFromPath(row.path),
        action: actionFromEntry(row.method, row.path),
        body: row.body,
        statusCode: row.statusCode,
        createdAt: row.createdAt,
      })),
      total,
      page,
      pageSize,
    };
  }

  private buildWhere(query: AuditQueryDto): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (query.userId) {
      where.userId = query.userId;
    }
    const pathClauses: Prisma.AuditLogWhereInput[] = [];
    if (query.entity) {
      pathClauses.push({
        OR: [
          { path: `/${query.entity}` },
          { path: { startsWith: `/${query.entity}/` } },
          { path: { startsWith: `/${query.entity}?` } },
        ],
      });
    }
    if (query.action) {
      const method = query.action.toUpperCase();
      pathClauses.push({
        OR: [
          { method },
          { path: { endsWith: `/${query.action}` } },
        ],
      });
    }
    if (pathClauses.length === 1) {
      Object.assign(where, pathClauses[0]);
    } else if (pathClauses.length > 1) {
      where.AND = pathClauses;
    }
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {};
      if (query.dateFrom) {
        where.createdAt.gte = new Date(query.dateFrom);
      }
      if (query.dateTo) {
        where.createdAt.lte = new Date(query.dateTo);
      }
    }
    return where;
  }

  private toData(entry: AuditEntry) {
    return {
      userId: entry.userId ?? null,
      method: entry.method,
      path: entry.path,
      body:
        entry.body === undefined
          ? undefined
          : (sanitizeAuditBody(entry.body) as never),
      statusCode: entry.statusCode ?? null,
    };
  }
}

function entityFromPath(path: string): string {
  const clean = path.split('?')[0] ?? path;
  return clean.split('/').filter(Boolean)[0] ?? '';
}

const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{25})$/i;

function actionFromEntry(method: string, path: string): string {
  const clean = path.split('?')[0] ?? path;
  const segments = clean.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && !ID_SEGMENT.test(last)) {
    return last;
  }
  return method;
}

/**
 * HTTP integration tests for /events/:eventId/documents and /reports through
 * the real app stack (global JWT guard + roles guard + throttler + validation)
 * with the database mocked. No Postgres connection is opened, and no test
 * stores a document: only rejection paths are exercised for uploads, and the
 * (per-run, temp-dir) storage root is verified unchanged afterwards. The one
 * test that touches the real shared stored-documents/ does so only to prove
 * isolation from it — see "storage root isolation (F32)" at the bottom.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  ACTORS,
  createTestApp,
  userRowFor,
  type ActorName,
  type TestApp,
} from '../support/harness.js';
import { DOC_MAX_BYTES } from '../../src/documents/document-file.js';
import { documentsRoot } from '../../src/documents/document-storage.js';

const NON_REPORT_ACTORS: ActorName[] = ['coordinator', 'instructor', 'officer', 'student'];

const EVENT_ROW = {
  id: 'evt-1',
  status: 'Planning',
  createdById: 'u-someone-else',
};

/** Event rows the summary aggregates: two events over two months and scopes. */
const SUMMARY_EVENT_ROWS = [
  {
    status: 'Completed',
    eventTypeId: 'type-1',
    eventDate: new Date('2026-01-15T00:00:00Z'),
    campusScope: 'OnCampus',
  },
  {
    status: 'Planning',
    eventTypeId: null,
    eventDate: new Date('2026-02-02T00:00:00Z'),
    campusScope: 'OffCampus',
  },
];

/** Files currently in the local document store (empty when it does not exist). */
function storedFiles(): string[] {
  const root = documentsRoot();
  if (!existsSync(root)) {
    return [];
  }
  return readdirSync(root, { recursive: true }).map(String).sort();
}

describe('documents + reports API (mocked database)', () => {
  let ctx: TestApp;

  /** Rows the fake resolves `user.findUnique` to, keyed by user id. */
  const users: Record<string, Record<string, unknown>> = {};

  const auth = (name: ActorName) =>
    ctx.bearer({ sub: ACTORS[name].sub, email: ACTORS[name].email });

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.prisma.reset();
    for (const key of Object.keys(users)) {
      delete users[key];
    }
    for (const name of Object.keys(ACTORS) as ActorName[]) {
      users[ACTORS[name].sub] = userRowFor(name);
    }
    ctx.prisma.on(
      'user.findUnique',
      (args: { where?: { id?: string; email?: string } } | undefined) => {
        const where = args?.where;
        if (where?.id) {
          return users[where.id] ?? null;
        }
        if (where?.email) {
          return (
            Object.values(users).find((row) => row.email === where.email) ?? null
          );
        }
        return null;
      },
    );
  });

  describe('GET /events/:eventId/documents', () => {
    it('requires authentication with 401', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents')
        .expect(401);
      expect(ctx.prisma.has('document.findMany')).toBe(false);
    });

    it("scopes the list to the caller's own uploads for a non-manager", async () => {
      ctx.prisma.on('event.findUnique', EVENT_ROW);
      ctx.prisma.on('document.findMany', [
        {
          id: 'doc-1',
          eventId: 'evt-1',
          uploadedById: ACTORS.student.sub,
          docType: 'Proposal',
          originalFilename: 'mine.pdf',
          mimeType: 'application/pdf',
          filePath: 'evt-1/mine.pdf',
          fileSize: 1234,
          createdAt: new Date('2026-01-10T09:00:00Z'),
          uploadedBy: {
            id: ACTORS.student.sub,
            firstName: 'student',
            lastName: 'Tester',
            email: ACTORS.student.email,
          },
        },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents')
        .set('Authorization', await auth('student'))
        .expect(200);

      const listArgs = ctx.prisma.callsFor('document.findMany')[0] as {
        where: Record<string, unknown>;
      };
      expect(listArgs.where).toEqual({
        eventId: 'evt-1',
        uploadedById: ACTORS.student.sub,
      });
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: 'doc-1', docType: 'Proposal' });
    });

    it('lists every document of the event for an event manager (Admin)', async () => {
      ctx.prisma.on('event.findUnique', EVENT_ROW);

      const res = await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents')
        .set('Authorization', await auth('admin'))
        .expect(200);

      const listArgs = ctx.prisma.callsFor('document.findMany')[0] as {
        where: Record<string, unknown>;
      };
      expect(listArgs.where).toEqual({ eventId: 'evt-1' });
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /events/:eventId/documents/:id/download', () => {
    it('requires authentication with 401', async () => {
      await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents/doc-1/download')
        .expect(401);
      expect(ctx.prisma.has('document.findFirst')).toBe(false);
    });

    it("refuses a non-manager's download of somebody else's document with 403", async () => {
      ctx.prisma.on('event.findUnique', EVENT_ROW);
      ctx.prisma.on('document.findFirst', {
        id: 'doc-1',
        eventId: 'evt-1',
        uploadedById: 'u-uploader',
        docType: 'Proposal',
        originalFilename: 'theirs.pdf',
        mimeType: 'application/pdf',
        filePath: 'evt-1/theirs.pdf',
        fileSize: 99,
      });

      const res = await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents/doc-1/download')
        .set('Authorization', await auth('student'))
        .expect(403);

      expect(res.body.message).toBe(
        'Only event managers or the uploader can download this document',
      );
      const findArgs = ctx.prisma.callsFor('document.findFirst')[0] as {
        where: Record<string, unknown>;
      };
      expect(findArgs.where).toEqual({ id: 'doc-1', eventId: 'evt-1' });
    });

    it('authorizes the uploader for their own document (storage lookup then 404s because no file is written on disk)', async () => {
      ctx.prisma.on('event.findUnique', EVENT_ROW);
      ctx.prisma.on('document.findFirst', {
        id: 'doc-2',
        eventId: 'evt-1',
        uploadedById: ACTORS.student.sub,
        docType: 'Report',
        originalFilename: 'mine.pdf',
        mimeType: 'application/pdf',
        filePath: 'evt-1/mine.pdf',
        fileSize: 42,
      });

      const res = await request(ctx.app.getHttpServer())
        .get('/events/evt-1/documents/doc-2/download')
        .set('Authorization', await auth('student'))
        .expect(404);

      // The authorization check passed (otherwise this would be 403): the only
      // reason for the 404 is that these tests never store a file on disk.
      expect(res.body.message).toBe('Document file not found in storage');
      expect(storedFiles()).toEqual([]);
    });
  });

  describe('POST /events/:eventId/documents (upload validation)', () => {
    it('rejects a disallowed MIME type with 400 before any storage write', async () => {
      const before = storedFiles();
      ctx.prisma.on('event.findUnique', EVENT_ROW);

      const res = await request(ctx.app.getHttpServer())
        .post('/events/evt-1/documents')
        .set('Authorization', await auth('admin'))
        .field('docType', 'Proposal')
        .attach('file', Buffer.from('definitely not a document'), {
          filename: 'payload.txt',
          contentType: 'text/plain',
        })
        .expect(400);

      expect(res.body.message).toContain('Document must be one of');
      expect(ctx.prisma.has('document.create')).toBe(false);
      expect(storedFiles()).toEqual(before);
    });

    it('rejects an oversized file before any storage write', async () => {
      const before = storedFiles();
      ctx.prisma.on('event.findUnique', EVENT_ROW);

      const oversized = Buffer.alloc(DOC_MAX_BYTES + 1, 0x61);
      const res = await request(ctx.app.getHttpServer())
        .post('/events/evt-1/documents')
        .set('Authorization', await auth('admin'))
        .field('docType', 'Photo')
        .attach('file', oversized, {
          filename: 'huge.png',
          contentType: 'image/png',
        })
        .expect(413);

      // multer's `limits.fileSize` (DOC_MAX_BYTES) trips before the request
      // ever reaches the controller, and Nest maps that to 413.
      expect(res.body.statusCode).toBe(413);
      expect(String(res.body.message)).toMatch(/file too large/i);
      expect(ctx.prisma.has('document.create')).toBe(false);
      expect(storedFiles()).toEqual(before);
    });

    it('rejects an unknown docType with 400 from the DTO before the service runs', async () => {
      const res = await request(ctx.app.getHttpServer())
        .post('/events/evt-1/documents')
        .set('Authorization', await auth('admin'))
        .field('docType', 'Malware')
        .expect(400);

      expect(JSON.stringify(res.body.message)).toContain('docType');
      expect(ctx.prisma.has('event.findUnique')).toBe(false);
      expect(ctx.prisma.has('document.create')).toBe(false);
      expect(storedFiles()).toEqual([]);
    });
  });

  describe('GET /reports/summary', () => {
    it('rejects an unauthenticated request with 401', async () => {
      await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .expect(401);
      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });

    it('returns event and task statistics for Admin', async () => {
      ctx.prisma.on('event.findMany', SUMMARY_EVENT_ROWS);
      ctx.prisma.on('eventType.findMany', [{ id: 'type-1', name: 'Seminar' }]);
      ctx.prisma.on('eventTask.groupBy', [
        { status: 'Done', _count: { _all: 1 } },
        { status: 'Todo', _count: { _all: 1 } },
      ]);

      const res = await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .set('Authorization', await auth('admin'))
        .expect(200);

      expect(res.body).toEqual({
        events: {
          total: 2,
          byStatus: { Completed: 1, Planning: 1 },
          byType: { Seminar: 1, Uncategorized: 1 },
          byMonth: { '2026-01': 1, '2026-02': 1 },
          byCampusScope: { OnCampus: 1, OffCampus: 1 },
        },
        tasks: { total: 2, done: 1, completionRate: 50 },
      });
    });

    it('lets a Department Head read the summary', async () => {
      ctx.prisma.on('event.findMany', SUMMARY_EVENT_ROWS);
      ctx.prisma.on('eventType.findMany', [{ id: 'type-1', name: 'Seminar' }]);
      ctx.prisma.on('eventTask.groupBy', []);

      const res = await request(ctx.app.getHttpServer())
        .get('/reports/summary')
        .set('Authorization', await auth('head'))
        .expect(200);

      expect(res.body.events.total).toBe(2);
      expect(res.body.tasks).toEqual({ total: 0, done: 0, completionRate: 0 });
    });

    it('forbids Coordinator, Instructor, Student Officer and Student from the summary with 403', async () => {
      for (const name of NON_REPORT_ACTORS) {
        const res = await request(ctx.app.getHttpServer())
          .get('/reports/summary')
          .set('Authorization', await auth(name))
          .expect(403);
        expect(res.body.statusCode).toBe(403);
      }
      expect(ctx.prisma.has('event.findMany')).toBe(false);
    });
  });

  describe('storage root isolation (F32)', () => {
    /** The production default root the suite must NOT be reading. */
    const sharedRoot = join(process.cwd(), 'stored-documents');
    const strayPath = join(sharedRoot, 'stray.txt');

    beforeAll(() => {
      // Recreate the real-world round-2 failure: a stray file from another
      // run (or a QA upload) sitting in the shared stored-documents/ while
      // this suite runs.
      mkdirSync(sharedRoot, { recursive: true });
      writeFileSync(strayPath, 'stray file from another run');
    });

    afterAll(() => {
      // Teardown always deletes the stray — and only the stray: the shared
      // root may hold genuine uploads, so nothing else is ever removed.
      rmSync(strayPath, { force: true });
    });

    it('reads the per-run storage root (empty) despite a stray file in shared stored-documents/', () => {
      // The stray really is there — so a read of the shared root can never
      // satisfy the assertion below.
      expect(existsSync(strayPath)).toBe(true);
      expect(storedFiles()).toEqual([]);
    });
  });
});

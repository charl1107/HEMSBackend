import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventsService } from './events.service.js';
import type { CoverStorage } from './cover-file.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { PUBLIC_EVENT_STATUSES } from './events.constants.js';
import { EVENT_TRANSITIONS } from './event-state.js';

const owner: AuthUser = {
  userId: 'u1',
  email: 'owner@hems.local',
  roles: ['Student Officer'],
};

const reviewer: AuthUser = {
  userId: 'r1',
  email: 'reviewer@hems.local',
  roles: ['Department Head'],
};

const stranger: AuthUser = {
  userId: 'x1',
  email: 'stranger@hems.local',
  roles: ['Instructor'],
};

// Ruling: Event Coordinators own their own events but lost cross-event power.
const coordinator: AuthUser = {
  userId: 'c1',
  email: 'coordinator@hems.local',
  roles: ['Event Coordinator'],
};

const admin: AuthUser = {
  userId: 'a1',
  email: 'admin@hems.local',
  roles: ['Admin'],
};

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

type MockPrisma = {
  event: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  eventType: {
    findUnique: ReturnType<typeof vi.fn>;
  };
};

function makePrisma(): MockPrisma {
  return {
    event: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
      count: vi.fn(),
    },
    eventType: {
      findUnique: vi.fn(),
    },
  };
}

type MockCoverStorage = CoverStorage & {
  put: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

// F34: the unit suite must never touch Supabase. The spec injects this stub
// through the service's optional COVER_STORAGE constructor slot, so
// createCoverStorage() (and its live fetch when SUPABASE_URL is set) never runs.
function makeCoverStorage(): MockCoverStorage {
  return {
    put: vi
      .fn()
      .mockImplementation(async (key: string) => `/uploads/${key}`),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function draftEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Gala Night',
    description: null,
    eventDate: new Date('2026-10-01T00:00:00.000Z'),
    venue: 'Main Hall',
    status: 'Planning',
    coverImageUrl: null,
    eventTypeId: null,
    eventType: null,
    createdById: 'u1',
    createdAt: new Date('2026-09-01'),
    updatedAt: new Date('2026-09-01'),
    ...overrides,
  };
}

describe('EventsService', () => {
  let prisma: MockPrisma;
  let coverStorage: MockCoverStorage;
  let service: EventsService;

  beforeEach(() => {
    prisma = makePrisma();
    coverStorage = makeCoverStorage();
    service = new EventsService(
      prisma as unknown as PrismaService,
      coverStorage,
    );
  });

  describe('public catalog filter', () => {
    it('lists only Planning | Ongoing | Completed', async () => {
      prisma.event.findMany.mockResolvedValue([
        draftEvent({ id: 'a', status: 'Ongoing' }),
        draftEvent({ id: 'b', status: 'Planning' }),
      ]);

      await service.findPublicMany();

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: [...PUBLIC_EVENT_STATUSES] } },
        }),
      );
      expect(PUBLIC_EVENT_STATUSES).not.toContain('Draft');
      expect(PUBLIC_EVENT_STATUSES).not.toContain('PendingApproval');
      expect(PUBLIC_EVENT_STATUSES).not.toContain('Rejected');
      expect(PUBLIC_EVENT_STATUSES).not.toContain('Approved');
    });

    it('detail query filters by id AND public status (non-public events never return)', async () => {
      prisma.event.findFirst.mockResolvedValue(null);

      await expect(service.findPublicOne('draft-id')).rejects.toThrow(
        NotFoundException,
      );

      expect(prisma.event.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'draft-id',
            status: { in: [...PUBLIC_EVENT_STATUSES] },
          },
        }),
      );
    });

    it('pages the public catalog and reports total', async () => {
      const items = [draftEvent({ id: 'a', status: 'Planning' })];
      prisma.event.findMany.mockResolvedValue(items);
      prisma.event.count.mockResolvedValue(40);

      await expect(service.findPublicMany({ limit: 10, offset: 30 })).resolves.toEqual({
        items,
        total: 40,
      });
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: { in: [...PUBLIC_EVENT_STATUSES] } },
          take: 10,
          skip: 30,
        }),
      );
      expect(prisma.event.count).toHaveBeenCalledWith({
        where: { status: { in: [...PUBLIC_EVENT_STATUSES] } },
      });
    });

    it('keeps public catalog inside public statuses when filters are supplied', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPublicMany({
        limit: 10,
        offset: 0,
        campusScope: 'OnCampus',
      });

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { status: { in: [...PUBLIC_EVENT_STATUSES] } },
              { campusScope: 'OnCampus' },
            ],
          },
        }),
      );
    });
  });

  describe('list pagination', () => {
    it('pages with limit/offset and returns items with total', async () => {
      const items = [draftEvent()];
      prisma.event.findMany.mockResolvedValue(items);
      prisma.event.count.mockResolvedValue(42);

      await expect(
        service.findPage({ limit: 10, offset: 20 }, reviewer),
      ).resolves.toEqual({
        items,
        total: 42,
      });
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          skip: 20,
          orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
        }),
      );
      expect(prisma.event.count).toHaveBeenCalledTimes(1);
    });

    it('applies status, campusScope and type filters to findMany and count', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPage(
        {
          limit: 100,
          offset: 0,
          status: ['Planning', 'Cancelled'],
          campusScope: 'OnCampus',
          type: 'Seminar',
        },
        reviewer,
      );

      const where = {
        status: { in: ['Planning', 'Cancelled'] },
        campusScope: 'OnCampus',
        eventType: { name: 'Seminar' },
      };
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      expect(prisma.event.count).toHaveBeenCalledWith({ where });
    });

    it('defaults to an unbounded-where page of 100 when no query given', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(3);

      await expect(service.findPage(undefined, reviewer)).resolves.toEqual({
        items: [],
        total: 3,
      });
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, take: 100, skip: 0 }),
      );
    });
  });

  describe('event visibility (findPage scoping + findOneVisible)', () => {
    it('gives reviewers an unscoped list', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPage(undefined, reviewer);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('scopes non-reviewers to own + public statuses', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPage(undefined, stranger);
      expect(prisma.event.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: { in: [...PUBLIC_EVENT_STATUSES] } },
              { createdById: 'x1' },
            ],
          },
        }),
      );

      await service.findPage(undefined, owner);
      expect(prisma.event.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: { in: [...PUBLIC_EVENT_STATUSES] } },
              { createdById: 'u1' },
            ],
          },
        }),
      );
    });

    it('combines query filters with the visibility scope', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      prisma.event.count.mockResolvedValue(0);

      await service.findPage({ status: ['Cancelled'] }, stranger);

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: [
              { status: { in: ['Cancelled'] } },
              {
                OR: [
                  { status: { in: [...PUBLIC_EVENT_STATUSES] } },
                  { createdById: 'x1' },
                ],
              },
            ],
          },
        }),
      );
    });

    it('returns public events to any authenticated user', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Planning' }),
      );

      await expect(service.findOneVisible('evt-1', stranger)).resolves.toMatchObject(
        { status: 'Planning' },
      );
    });

    it('hides Cancelled events from non-owners; owner and reviewers still see them', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Cancelled' }),
      );

      await expect(service.findOneVisible('evt-1', owner)).resolves.toMatchObject(
        { id: 'evt-1' },
      );
      await expect(service.findOneVisible('evt-1', reviewer)).resolves.toMatchObject(
        { id: 'evt-1' },
      );
      await expect(service.findOneVisible('evt-1', stranger)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('keeps Cancelled events from non-owner peers', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Cancelled' }),
      );

      await expect(service.findOneVisible('evt-1', stranger)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOneVisible('evt-1', reviewer)).resolves.toMatchObject(
        { status: 'Cancelled' },
      );
    });
  });

  describe('conflict check', () => {
    it('create returns conflictWarning when same venue+date exists', async () => {
      prisma.eventType.findUnique.mockResolvedValue(null);
      prisma.event.create.mockResolvedValue(draftEvent());
      prisma.event.findFirst.mockResolvedValue({
        id: 'other',
        title: 'Wedding Expo',
        venue: 'main hall',
        eventDate: new Date('2026-10-01T00:00:00.000Z'),
      });

      const result = await service.create({
        title: 'Gala Night',
        eventDate: '2026-10-01',
        venue: '  Main Hall ',
      });

      expect(prisma.event.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            venue: { equals: 'Main Hall', mode: 'insensitive' },
            eventDate: new Date('2026-10-01'),
            status: { notIn: ['Cancelled'] },
          }),
        }),
      );
      expect(result.conflictWarning).toContain('Wedding Expo');
      expect(result.status).toBe('Planning');
    });

    it('create returns null conflictWarning when no conflict', async () => {
      prisma.event.create.mockResolvedValue(draftEvent());
      prisma.event.findFirst.mockResolvedValue(null);

      const result = await service.create({
        title: 'Gala Night',
        eventDate: '2026-10-01',
        venue: 'Main Hall',
      });

      expect(result.conflictWarning).toBeNull();
    });

    it('create() with a free venue returns conflictWarning: null', async () => {
      prisma.event.create.mockResolvedValue(draftEvent({ id: 'evt-new' }));
      // The conflict probe runs after the insert, so the query matches the row
      // just written unless the new event's own id is excluded from it.
      prisma.event.findFirst.mockImplementation(
        (args: { where: { id?: { not?: string } } }) =>
          args?.where?.id?.not === 'evt-new' ? null : draftEvent({ id: 'evt-new' }),
      );

      const result = await service.create({
        title: 'Gala Night',
        eventDate: '2026-10-01',
        venue: 'Main Hall',
      });

      const where = prisma.event.findFirst.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'evt-new' });
      expect(result.conflictWarning).toBeNull();
    });

    it('conflict excludes self and Cancelled events', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());
      prisma.event.update.mockResolvedValue(draftEvent());
      prisma.event.findFirst.mockResolvedValue(null);

      await service.update('evt-1', { venue: 'Annex' }, owner);

      const where = prisma.event.findFirst.mock.calls[0][0].where;
      expect(where.id).toEqual({ not: 'evt-1' });
      expect(where.status).toEqual({ notIn: ['Cancelled'] });
    });
  });

  describe('status edit guard', () => {
    it('update rejects when status is Completed', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Completed' }),
      );

      await expect(
        service.update('evt-1', { title: 'New' }, owner),
      ).rejects.toThrow(ConflictException);
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('delete rejects when status is Cancelled', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Cancelled' }),
      );

      await expect(service.remove('evt-1', owner)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.event.delete).not.toHaveBeenCalled();
    });

    it('allows edit while Ongoing', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Ongoing' }),
      );
      prisma.event.update.mockResolvedValue(
        draftEvent({ status: 'Ongoing', title: 'Updated' }),
      );
      prisma.event.findFirst.mockResolvedValue(null);

      const result = await service.update(
        'evt-1',
        { title: 'Updated' },
        owner,
      );
      expect(result.title).toBe('Updated');
    });

    it('allows delete while Planning', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());
      prisma.event.delete.mockResolvedValue(draftEvent());

      await expect(service.remove('evt-1', owner)).resolves.toBeUndefined();
      expect(prisma.event.delete).toHaveBeenCalledWith({
        where: { id: 'evt-1' },
      });
    });
  });

  describe('cover upload validation', () => {
    it('rejects non-allow-listed mime type', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());

      await expect(
        service.setCover(
          'evt-1',
          {
            buffer: Buffer.from('%PDF-1.7'),
            mimetype: 'application/pdf',
          },
          owner,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects allow-listed mime with wrong magic bytes', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());

      await expect(
        service.setCover(
          'evt-1',
          {
            buffer: Buffer.from('not an image, just text pretending'),
            mimetype: 'image/png',
          },
          owner,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when file is missing', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());

      await expect(
        service.setCover('evt-1', undefined, owner),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts valid PNG and persists coverImageUrl', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(16),
      ]);
      prisma.event.findUnique.mockResolvedValue(draftEvent());
      prisma.event.update.mockResolvedValue(
        draftEvent({ coverImageUrl: '/uploads/covers/evt-1/x.png' }),
      );

      const result = await service.setCover(
        'evt-1',
        {
          buffer: png,
          mimetype: 'image/png',
        },
        owner,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
      expect(prisma.event.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            coverImageUrl: expect.stringMatching(
              /^\/uploads\/covers\/evt-1\/.+\.png$/,
            ),
          },
        }),
      );
      expect(result.coverImageUrl).toContain('.png');
    });

    it('rejects cover upload when event is not editable', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Completed' }),
      );

      await expect(
        service.setCover(
          'evt-1',
          {
            buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
            mimetype: 'image/jpeg',
          },
          owner,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('edit authorization (owner, Department Head or Admin)', () => {
    it('rejects a non-owner without an edit role', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());

      await expect(
        service.update('evt-1', { title: 'Hijacked' }, stranger),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('rejects a non-owner Event Coordinator (edit power is owner-only for them)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ createdById: 'someone-else' }),
      );

      await expect(
        service.update('evt-1', { title: 'Hijacked' }, coordinator),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('allows a Department Head to edit another owner event', async () => {
      prisma.event.findUnique.mockResolvedValue(draftEvent());
      prisma.event.update.mockResolvedValue(
        draftEvent({ title: 'Reviewed edit' }),
      );
      prisma.event.findFirst.mockResolvedValue(null);

      const result = await service.update(
        'evt-1',
        { title: 'Reviewed edit' },
        reviewer,
      );
      expect(result.title).toBe('Reviewed edit');
    });

    it('rejects removeCover for a non-owner without an edit role', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ coverImageUrl: '/uploads/covers/evt-1/x.png' }),
      );

      await expect(service.removeCover('evt-1', stranger)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.event.update).not.toHaveBeenCalled();
    });
  });

  describe('advance lifecycle (owner / Admin / Department Head)', () => {
    it('succeeds for the owner on every legal transition in EVENT_TRANSITIONS', async () => {
      const legal = Object.entries(EVENT_TRANSITIONS).flatMap(([from, targets]) =>
        (targets ?? []).map((to) => [from, to] as const),
      );
      expect(legal).toEqual([
        ['Planning', 'Ongoing'],
        ['Planning', 'Cancelled'],
        ['Ongoing', 'Completed'],
        ['Ongoing', 'Cancelled'],
        ['Cancelled', 'Planning'],
      ]);

      for (const [from, to] of legal) {
        prisma.event.findUnique
          .mockResolvedValueOnce(draftEvent({ status: from }))
          .mockResolvedValueOnce(draftEvent({ status: to }));
        prisma.event.updateMany.mockResolvedValue({ count: 1 });

        await expect(
          service.advance('evt-1', to, owner),
        ).resolves.toMatchObject({ status: to });
        expect(prisma.event.updateMany).toHaveBeenLastCalledWith({
          where: { id: 'evt-1', status: from },
          data: { status: to },
        });
      }
    });

    it('rejects Completed → Ongoing with 409 Invalid event status transition', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Completed' }),
      );

      const error = await service
        .advance('evt-1', 'Ongoing', owner)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe(
        'Invalid event status transition Completed → Ongoing',
      );
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });

    it('allows a non-owner Admin and Department Head to advance', async () => {
      for (const user of [admin, reviewer]) {
        prisma.event.findUnique
          .mockResolvedValueOnce(
            draftEvent({ status: 'Planning', createdById: 'someone-else' }),
          )
          .mockResolvedValueOnce(
            draftEvent({ status: 'Ongoing', createdById: 'someone-else' }),
          );
        prisma.event.updateMany.mockResolvedValue({ count: 1 });

        await expect(service.advance('evt-1', 'Ongoing', user)).resolves.toMatchObject(
          { status: 'Ongoing' },
        );
      }
    });

    it('denies a non-owner Event Coordinator (and anyone else outside the ruling)', async () => {
      for (const user of [coordinator, stranger]) {
        prisma.event.findUnique.mockResolvedValue(
          draftEvent({ createdById: 'someone-else' }),
        );

        const error = await service
          .advance('evt-1', 'Ongoing', user)
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(ForbiddenException);
      }
      expect(prisma.event.updateMany).not.toHaveBeenCalled();
    });

    it('keeps the optimistic-lock 409 event status changed', async () => {
      prisma.event.findUnique.mockResolvedValue(
        draftEvent({ status: 'Planning' }),
      );
      prisma.event.updateMany.mockResolvedValue({ count: 0 });

      const error = await service
        .advance('evt-1', 'Ongoing', owner)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toBe('event status changed');
    });
  });

  describe('CRUD happy paths', () => {
    it('create trims venue and defaults to Planning', async () => {
      prisma.event.create.mockResolvedValue(draftEvent());
      prisma.event.findFirst.mockResolvedValue(null);

      await service.create(
        {
          title: 'Gala Night',
          eventDate: '2026-10-01',
          venue: '  Main Hall  ',
        },
        'user-9',
      );

      expect(prisma.event.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            venue: 'Main Hall',
            status: 'Planning',
            createdById: 'user-9',
          }),
        }),
      );
    });

    it('findOne throws NotFound for unknown id', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

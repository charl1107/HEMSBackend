import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DocumentsService } from './documents.service.js';
import type { DocumentStorage } from './document-storage.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';

type MockPrisma = {
  event: { findUnique: ReturnType<typeof vi.fn> };
  committeeMember: { findFirst: ReturnType<typeof vi.fn> };
  document: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

type MockStorage = DocumentStorage & {
  put: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const PDF = Buffer.from('%PDF-1.7\n%%EOF');

function makePrisma(): MockPrisma {
  return {
    event: { findUnique: vi.fn() },
    committeeMember: { findFirst: vi.fn().mockResolvedValue(null) },
    document: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

function makeStorage(): MockStorage {
  return {
    put: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue({ kind: 'buffer', buffer: PDF }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'Planning',
    createdById: 'owner-1',
    ...overrides,
  };
}

function baseDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    eventId: 'evt-1',
    uploadedById: 'uploader-1',
    docType: 'Proposal',
    filePath: 'evt-1/abc.pdf',
    originalFilename: 'proposal.pdf',
    mimeType: 'application/pdf',
    fileSize: PDF.length,
    createdAt: new Date('2026-09-23T00:00:00Z'),
    ...overrides,
  };
}

function owner(): AuthUser {
  return { userId: 'owner-1', email: 'o@hems.local', roles: ['Event Coordinator'] };
}

function uploader(): AuthUser {
  return { userId: 'uploader-1', email: 'u@hems.local', roles: ['Student Officer'] };
}

function admin(): AuthUser {
  return { userId: 'a1', email: 'a@hems.local', roles: ['Admin'] };
}

function student(): AuthUser {
  return { userId: 's1', email: 's@hems.local', roles: ['Student'] };
}

function pdfFile(overrides: Record<string, unknown> = {}) {
  return {
    buffer: PDF,
    mimetype: 'application/pdf',
    originalname: 'proposal.pdf',
    ...overrides,
  };
}

describe('DocumentsService', () => {
  let prisma: MockPrisma;
  let storage: MockStorage;
  let service: DocumentsService;

  beforeEach(() => {
    prisma = makePrisma();
    storage = makeStorage();
    service = new DocumentsService(
      prisma as unknown as PrismaService,
      storage,
    );
    prisma.event.findUnique.mockResolvedValue(baseEvent());
  });

  describe('upload', () => {
    it('rejects invalid doc_type (400)', async () => {
      await expect(
        service.upload('evt-1', owner(), 'Invoice', pdfFile()),
      ).rejects.toThrow(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('rejects files failing validation (400)', async () => {
      await expect(
        service.upload('evt-1', owner(), 'Proposal', {
          buffer: Buffer.from('MZ'),
          mimetype: 'application/pdf',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('rejects missing file (400)', async () => {
      await expect(
        service.upload('evt-1', owner(), 'Proposal', undefined),
      ).rejects.toThrow(BadRequestException);
    });

    it('forbids upload by outsider without committee membership (403)', async () => {
      await expect(
        service.upload('evt-1', student(), 'Proposal', pdfFile()),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('allows upload by event owner and stores file', async () => {
      await expect(
        service.upload('evt-1', owner(), 'Proposal', pdfFile()),
      ).resolves.toEqual({});
      expect(storage.put).toHaveBeenCalledWith(
        expect.stringMatching(/^evt-1\/.+\.pdf$/),
        PDF,
        'application/pdf',
      );
      expect(prisma.document.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventId: 'evt-1',
            uploadedById: 'owner-1',
            docType: 'Proposal',
            mimeType: 'application/pdf',
            fileSize: PDF.length,
          }),
        }),
      );
    });

    it('allows upload by Admin without committee membership', async () => {
      await expect(
        service.upload('evt-1', admin(), 'Report', pdfFile()),
      ).resolves.toEqual({});
      expect(prisma.document.create).toHaveBeenCalled();
    });

    it('blocks upload when event is Cancelled (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );
      await expect(
        service.upload('evt-1', owner(), 'Proposal', pdfFile()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(
        service.upload('missing', owner(), 'Proposal', pdfFile()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('download authorization', () => {
    it('forbids download by non-uploader non-manager (403)', async () => {
      prisma.document.findFirst.mockResolvedValue(baseDoc());

      await expect(
        service.download('evt-1', 'doc-1', student()),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('allows download by the uploader', async () => {
      prisma.document.findFirst.mockResolvedValue(baseDoc());

      const result = await service.download('evt-1', 'doc-1', uploader());
      expect(result.kind).toBe('buffer');
      expect(storage.download).toHaveBeenCalledWith('evt-1/abc.pdf');
    });

    it('allows download by event owner (manager)', async () => {
      prisma.document.findFirst.mockResolvedValue(
        baseDoc({ uploadedById: 'someone-else' }),
      );

      const result = await service.download('evt-1', 'doc-1', owner());
      expect(result.kind).toBe('buffer');
    });

    it('allows download by Admin', async () => {
      prisma.document.findFirst.mockResolvedValue(
        baseDoc({ uploadedById: 'someone-else' }),
      );

      const result = await service.download('evt-1', 'doc-1', admin());
      expect(result.kind).toBe('buffer');
      expect(prisma.committeeMember.findFirst).not.toHaveBeenCalled();
    });

    it('scopes document lookup to the event (404 across events)', async () => {
      prisma.document.findFirst.mockResolvedValue(null);

      await expect(
        service.download('evt-1', 'doc-from-other-event', owner()),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.document.findFirst).toHaveBeenCalledWith({
        where: { id: 'doc-from-other-event', eventId: 'evt-1' },
      });
      expect(storage.download).not.toHaveBeenCalled();
    });

    it('404 when the file is missing from storage', async () => {
      prisma.document.findFirst.mockResolvedValue(baseDoc());
      storage.download.mockResolvedValue(null);

      await expect(
        service.download('evt-1', 'doc-1', uploader()),
      ).rejects.toThrow(NotFoundException);
    });

    it('passes through signed-URL redirect results', async () => {
      prisma.document.findFirst.mockResolvedValue(baseDoc());
      storage.download.mockResolvedValue({
        kind: 'redirect',
        url: 'https://cdn.example/signed',
      });

      await expect(service.download('evt-1', 'doc-1', uploader())).resolves.toEqual(
        { kind: 'redirect', url: 'https://cdn.example/signed' },
      );
    });
  });

  describe('list scoping', () => {
    it('lists all event docs for managers', async () => {
      await service.findMany('evt-1', admin());
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { eventId: 'evt-1' } }),
      );
      expect(prisma.committeeMember.findFirst).not.toHaveBeenCalled();
    });

    it('limits non-managers to their own uploads', async () => {
      await service.findMany('evt-1', student());
      expect(prisma.document.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { eventId: 'evt-1', uploadedById: 's1' },
        }),
      );
    });

    it('404 when event missing', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.findMany('missing', owner())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('delete', () => {
    it('forbids delete by outsider (403)', async () => {
      await expect(
        service.remove('evt-1', 'doc-1', student()),
      ).rejects.toThrow(ForbiddenException);
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.document.delete).not.toHaveBeenCalled();
    });

    it('allows delete by event owner and removes the file', async () => {
      prisma.document.findFirst.mockResolvedValue(baseDoc());

      await service.remove('evt-1', 'doc-1', owner());
      expect(storage.remove).toHaveBeenCalledWith('evt-1/abc.pdf');
      expect(prisma.document.delete).toHaveBeenCalledWith({
        where: { id: 'doc-1' },
      });
    });

    it('blocks delete when event is Cancelled (409)', async () => {
      prisma.event.findUnique.mockResolvedValue(
        baseEvent({ status: 'Cancelled' }),
      );
      await expect(
        service.remove('evt-1', 'doc-1', owner()),
      ).rejects.toThrow(ConflictException);
      expect(prisma.document.delete).not.toHaveBeenCalled();
    });

    it('404 when document is not on this event', async () => {
      prisma.document.findFirst.mockResolvedValue(null);
      await expect(service.remove('evt-1', 'nope', owner())).rejects.toThrow(
        NotFoundException,
      );
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });
});

import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Document } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from '../common/auth-user.js';
import {
  canManagePlanning,
  assertPlanningStatusGate,
  findPlanningEvent,
  type PlanningEvent,
} from '../common/planning-access.js';
import {
  assertDocType,
  assertDocumentFile,
  documentExtension,
  type DocumentUploadFile,
} from './document-file.js';
import { DOCUMENT_STORAGE, type DocumentStorage } from './document-storage.js';

export type DocumentDownloadResult =
  | { kind: 'buffer'; buffer: Buffer; mimeType: string; filename: string }
  | { kind: 'redirect'; url: string };

const DOCUMENT_INCLUDE = {
  uploadedBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
} as const;

export type DocumentWithUploader = Document & {
  uploadedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
  ) {}

  async findMany(eventId: string, auth: AuthUser): Promise<DocumentWithUploader[]> {
    const event = await findPlanningEvent(this.prisma, eventId);
    const canManage = await canManagePlanning(this.prisma, event, auth);
    return this.prisma.document.findMany({
      where: canManage ? { eventId } : { eventId, uploadedById: auth.userId },
      include: DOCUMENT_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  async upload(
    eventId: string,
    auth: AuthUser,
    docType: string,
    file: DocumentUploadFile | undefined,
  ): Promise<DocumentWithUploader> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await this.assertManager(event, auth);
    const type = assertDocType(docType);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Document file is required');
    }
    const mime = assertDocumentFile(file);
    const key = `${eventId}/${randomUUID()}.${documentExtension(mime)}`;
    await this.storage.put(key, file.buffer, mime);
    return this.prisma.document.create({
      data: {
        eventId,
        uploadedById: auth.userId,
        docType: type,
        filePath: key,
        originalFilename: file.originalname || 'upload',
        mimeType: mime,
        fileSize: file.buffer.length,
      },
      include: DOCUMENT_INCLUDE,
    });
  }

  async download(
    eventId: string,
    id: string,
    auth: AuthUser,
  ): Promise<DocumentDownloadResult> {
    const event = await findPlanningEvent(this.prisma, eventId);
    const doc = await this.findDocument(eventId, id);
    if (doc.uploadedById !== auth.userId) {
      const canManage = await canManagePlanning(this.prisma, event, auth);
      if (!canManage) {
        throw new ForbiddenException(
          'Only event managers or the uploader can download this document',
        );
      }
    }
    const result = await this.storage.download(doc.filePath);
    if (!result) {
      throw new NotFoundException('Document file not found in storage');
    }
    if (result.kind === 'redirect') {
      return result;
    }
    return {
      kind: 'buffer',
      buffer: result.buffer,
      mimeType: doc.mimeType,
      filename: doc.originalFilename,
    };
  }

  async remove(eventId: string, id: string, auth: AuthUser): Promise<void> {
    const event = await findPlanningEvent(this.prisma, eventId);
    assertPlanningStatusGate(event);
    await this.assertManager(event, auth);
    const doc = await this.findDocument(eventId, id);
    await this.storage.remove(doc.filePath);
    await this.prisma.document.delete({ where: { id: doc.id } });
  }

  private async findDocument(
    eventId: string,
    id: string,
  ): Promise<Document> {
    const doc = await this.prisma.document.findFirst({
      where: { id, eventId },
    });
    if (!doc) {
      throw new NotFoundException('Document not found');
    }
    return doc;
  }

  private async assertManager(
    event: PlanningEvent,
    auth: AuthUser,
  ): Promise<void> {
    const canManage = await canManagePlanning(this.prisma, event, auth);
    if (!canManage) {
      throw new ForbiddenException(
        'Only the event owner, a committee member of this event, Admin, or Department Head can manage documents',
      );
    }
  }
}

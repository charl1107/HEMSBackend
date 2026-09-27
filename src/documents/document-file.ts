import { BadRequestException } from '@nestjs/common';
import { detectImageMime } from '../events/cover-file.js';

export const DOC_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_ALLOWED_MIME = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const DOC_TYPES = [
  'Proposal',
  'Program',
  'Certificate',
  'Photo',
  'Report',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  [DOCX_MIME]: 'docx',
};

export interface DocumentUploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size?: number;
}

export function assertDocType(value: string): DocType {
  if (!(DOC_TYPES as readonly string[]).includes(value)) {
    throw new BadRequestException(
      `docType must be one of: ${DOC_TYPES.join(', ')}`,
    );
  }
  return value as DocType;
}

export function detectDocumentMime(buffer: Buffer): string | null {
  const image = detectImageMime(buffer);
  if (image) {
    return image;
  }
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return DOCX_MIME;
  }
  return null;
}

export function assertDocumentFile(file: DocumentUploadFile): string {
  if (!file.buffer?.length) {
    throw new BadRequestException('Document file is required');
  }
  if (file.buffer.length > DOC_MAX_BYTES) {
    throw new BadRequestException('Document must be 10MB or smaller');
  }
  if (!(DOC_ALLOWED_MIME as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestException(
      `Document must be one of: ${DOC_ALLOWED_MIME.join(', ')}`,
    );
  }
  const detected = detectDocumentMime(file.buffer);
  if (!detected) {
    throw new BadRequestException('Document failed magic-byte validation');
  }
  if (detected !== file.mimetype) {
    throw new BadRequestException(
      `Document content (${detected}) does not match declared type (${file.mimetype})`,
    );
  }
  return detected;
}

export function documentExtension(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new BadRequestException('Unsupported document type');
  }
  return ext;
}

export function contentDisposition(filename: string): string {
  const ascii = filename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertDocType,
  assertDocumentFile,
  contentDisposition,
  detectDocumentMime,
  DOC_MAX_BYTES,
} from './document-file.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '),
]);
const PDF = Buffer.from('%PDF-1.7\n%âãÏÓ');
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x14, 0x00, 0x06, 0x00]),
]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe('assertDocType', () => {
  it('accepts the five doc types', () => {
    for (const type of [
      'Proposal',
      'Program',
      'Certificate',
      'Photo',
      'Report',
    ]) {
      expect(assertDocType(type)).toBe(type);
    }
  });

  it('rejects unknown doc types (400)', () => {
    expect(() => assertDocType('Invoice')).toThrow(BadRequestException);
    expect(() => assertDocType('proposal')).toThrow(BadRequestException);
  });
});

describe('detectDocumentMime', () => {
  it('detects pdf, docx, and images', () => {
    expect(detectDocumentMime(PDF)).toBe('application/pdf');
    expect(detectDocumentMime(DOCX)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(detectDocumentMime(JPEG)).toBe('image/jpeg');
    expect(detectDocumentMime(PNG)).toBe('image/png');
    expect(detectDocumentMime(WEBP)).toBe('image/webp');
  });

  it('returns null for unknown content', () => {
    expect(detectDocumentMime(EXE)).toBeNull();
    expect(detectDocumentMime(Buffer.from('hello'))).toBeNull();
  });
});

describe('assertDocumentFile', () => {
  it('accepts matching allow-listed types', () => {
    expect(assertDocumentFile({ buffer: PDF, mimetype: 'application/pdf' })).toBe(
      'application/pdf',
    );
    expect(
      assertDocumentFile({
        buffer: DOCX,
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(assertDocumentFile({ buffer: JPEG, mimetype: 'image/jpeg' })).toBe(
      'image/jpeg',
    );
    expect(assertDocumentFile({ buffer: PNG, mimetype: 'image/png' })).toBe(
      'image/png',
    );
    expect(assertDocumentFile({ buffer: WEBP, mimetype: 'image/webp' })).toBe(
      'image/webp',
    );
  });

  it('rejects types outside the allow-list', () => {
    expect(() =>
      assertDocumentFile({ buffer: EXE, mimetype: 'application/x-msdownload' }),
    ).toThrow(/one of/);
  });

  it('rejects declared type that does not match magic bytes', () => {
    expect(() =>
      assertDocumentFile({ buffer: JPEG, mimetype: 'application/pdf' }),
    ).toThrow(/does not match/);
    expect(() =>
      assertDocumentFile({ buffer: PDF, mimetype: 'image/png' }),
    ).toThrow(/does not match/);
  });

  it('rejects content with no recognizable magic bytes', () => {
    expect(() =>
      assertDocumentFile({ buffer: Buffer.from('plain text'), mimetype: 'application/pdf' }),
    ).toThrow(/magic-byte/);
  });

  it('rejects empty files', () => {
    expect(() =>
      assertDocumentFile({ buffer: Buffer.alloc(0), mimetype: 'application/pdf' }),
    ).toThrow(/required/);
  });

  it('rejects files over the 10MB limit', () => {
    const big = Buffer.concat([PDF, Buffer.alloc(DOC_MAX_BYTES)]);
    expect(() =>
      assertDocumentFile({ buffer: big, mimetype: 'application/pdf' }),
    ).toThrow(/10MB/);
  });
});

describe('contentDisposition', () => {
  it('escapes quotes and adds RFC 5987 filename', () => {
    const header = contentDisposition('my "report".pdf');
    expect(header).toContain('attachment;');
    expect(header).not.toContain('"my "report".pdf"');
    expect(header).toContain("filename*=UTF-8''");
  });
});

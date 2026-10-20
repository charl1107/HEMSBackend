import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  assertCoverFile,
  coverUrlToDiskPath,
  detectImageMime,
} from './cover-file.js';

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

describe('detectImageMime', () => {
  it('detects jpeg, png, webp', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(WEBP)).toBe('image/webp');
  });

  it('returns null for pdf and text', () => {
    expect(detectImageMime(PDF)).toBeNull();
    expect(detectImageMime(Buffer.from('hello world'))).toBeNull();
  });
});

describe('assertCoverFile', () => {
  it('accepts matching allow-listed types', () => {
    expect(assertCoverFile({ buffer: JPEG, mimetype: 'image/jpeg' })).toBe(
      'image/jpeg',
    );
    expect(assertCoverFile({ buffer: PNG, mimetype: 'image/png' })).toBe(
      'image/png',
    );
    expect(assertCoverFile({ buffer: WEBP, mimetype: 'image/webp' })).toBe(
      'image/webp',
    );
  });

  it('rejects application/pdf even with pdf magic bytes', () => {
    expect(() =>
      assertCoverFile({ buffer: PDF, mimetype: 'application/pdf' }),
    ).toThrow(BadRequestException);
  });

  it('rejects image/png declared type when bytes are not png', () => {
    expect(() =>
      assertCoverFile({ buffer: JPEG, mimetype: 'image/png' }),
    ).toThrow(BadRequestException);
  });

  it('rejects files over 5MB', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
    expect(() =>
      assertCoverFile({ buffer: big, mimetype: 'image/png' }),
    ).toThrow(/5MB/);
  });
});

describe('coverUrlToDiskPath', () => {
  it('maps safe cover URLs under uploads/covers', () => {
    const path = coverUrlToDiskPath('/uploads/covers/evt-1/a.png');
    expect(path?.replace(/\\/g, '/')).toContain('/uploads/covers/evt-1/a.png');
  });

  it('rejects traversal and foreign prefixes', () => {
    expect(coverUrlToDiskPath('/uploads/covers/../../etc/passwd')).toBeNull();
    expect(coverUrlToDiskPath('https://evil.example/x.png')).toBeNull();
    expect(coverUrlToDiskPath('/uploads/other/x.png')).toBeNull();
  });
});

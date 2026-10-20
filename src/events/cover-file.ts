import { BadRequestException } from '@nestjs/common';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const COVER_MAX_BYTES = 5 * 1024 * 1024;
export const COVER_ALLOWED_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const COVER_URL_PREFIX = '/uploads/';
export const UPLOADS_ROOT = join(process.cwd(), 'uploads');
export const COVER_STORAGE = 'COVER_STORAGE';
export const DEFAULT_SUPABASE_COVERS_BUCKET = 'event-covers';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface CoverUploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  size?: number;
}

export function detectImageMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function assertCoverFile(file: CoverUploadFile): string {
  if (!file.buffer?.length) {
    throw new BadRequestException('Cover image file is required');
  }
  if (file.buffer.length > COVER_MAX_BYTES) {
    throw new BadRequestException('Cover image must be 5MB or smaller');
  }
  if (!(COVER_ALLOWED_MIME as readonly string[]).includes(file.mimetype)) {
    throw new BadRequestException(
      `Cover image must be one of: ${COVER_ALLOWED_MIME.join(', ')}`,
    );
  }
  const detected = detectImageMime(file.buffer);
  if (!detected) {
    throw new BadRequestException('Cover image failed magic-byte validation');
  }
  if (detected !== file.mimetype) {
    throw new BadRequestException(
      `Cover image content (${detected}) does not match declared type (${file.mimetype})`,
    );
  }
  return detected;
}

export function coverExtension(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new BadRequestException('Unsupported cover image type');
  }
  return ext;
}

export function coverUrlToDiskPath(coverImageUrl: string): string | null {
  if (!coverImageUrl.startsWith(COVER_URL_PREFIX)) {
    return null;
  }
  const relative = coverImageUrl.slice(COVER_URL_PREFIX.length);
  if (!relative.startsWith('covers/')) {
    return null;
  }
  if (relative.includes('..') || relative.includes('\0')) {
    return null;
  }
  return join(UPLOADS_ROOT, relative);
}

export interface CoverStorage {
  put(key: string, data: Buffer, mimeType: string): Promise<string>;
  remove(coverImageUrlOrKey: string): Promise<void>;
}

export class LocalCoverStorage implements CoverStorage {
  async put(key: string, data: Buffer): Promise<string> {
    const relative = key.replace(/\\/g, '/');
    if (relative.includes('..') || relative.includes('\0')) {
      throw new BadRequestException('Invalid cover storage key');
    }
    const fullPath = join(UPLOADS_ROOT, ...relative.split('/'));
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
    return `${COVER_URL_PREFIX}${relative}`;
  }

  async remove(coverImageUrlOrKey: string): Promise<void> {
    const diskPath = coverImageUrlOrKey.startsWith(COVER_URL_PREFIX)
      ? coverUrlToDiskPath(coverImageUrlOrKey)
      : join(UPLOADS_ROOT, ...coverImageUrlOrKey.split('/'));
    if (!diskPath) {
      return;
    }
    try {
      await unlink(diskPath);
    } catch {
      // already deleted or does not exist
    }
  }
}

export interface SupabaseCoverStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export class SupabaseCoverStorage implements CoverStorage {
  constructor(private readonly config: SupabaseCoverStorageConfig) {}

  private objectUrl(key: string): string {
    return `${this.config.url}/storage/v1/object/${this.config.bucket}/${key}`;
  }

  private publicUrl(key: string): string {
    return `${this.config.url}/storage/v1/object/public/${this.config.bucket}/${key}`;
  }

  private authHeaders(contentType?: string): HeadersInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.serviceKey}`,
      apikey: this.config.serviceKey,
    };
    if (contentType) {
      headers['content-type'] = contentType;
    }
    return headers;
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<string> {
    const response = await fetch(this.objectUrl(key), {
      method: 'PUT',
      headers: this.authHeaders(mimeType),
      body: new Uint8Array(data),
    });
    if (!response.ok) {
      throw new Error(`Supabase Storage cover upload failed (${response.status})`);
    }
    return this.publicUrl(key);
  }

  async remove(coverImageUrlOrKey: string): Promise<void> {
    let key = coverImageUrlOrKey;
    const prefix = `${this.config.url}/storage/v1/object/public/${this.config.bucket}/`;
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
    }
    const response = await fetch(this.objectUrl(key), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Supabase Storage delete cover failed (${response.status})`);
    }
  }
}

export interface CoverStorageEnv {
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
  SUPABASE_COVERS_BUCKET?: string | undefined;
}

export function createCoverStorage(env: CoverStorageEnv = process.env): CoverStorage {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return new SupabaseCoverStorage({
      url: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: env.SUPABASE_COVERS_BUCKET || DEFAULT_SUPABASE_COVERS_BUCKET,
    });
  }
  return new LocalCoverStorage();
}

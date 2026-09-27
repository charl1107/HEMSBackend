import { BadRequestException } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DOCUMENT_STORAGE = 'DOCUMENT_STORAGE';
export const DOCUMENTS_ROOT = join(process.cwd(), 'stored-documents');
export const SIGNED_URL_TTL_SECONDS = 300;
export const DEFAULT_SUPABASE_BUCKET = 'event-documents';

export type DocumentDownload =
  | { kind: 'buffer'; buffer: Buffer }
  | { kind: 'redirect'; url: string };

export interface DocumentStorage {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  download(key: string): Promise<DocumentDownload | null>;
  remove(key: string): Promise<void>;
}

export interface DocumentStorageEnv {
  SUPABASE_URL?: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY?: string | undefined;
  SUPABASE_STORAGE_BUCKET?: string | undefined;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export function documentKeyToDiskPath(key: string): string | null {
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/')) {
    return null;
  }
  if (key.split('/').some((segment) => segment === '..' || segment === '.')) {
    return null;
  }
  if (!KEY_PATTERN.test(key)) {
    return null;
  }
  return join(DOCUMENTS_ROOT, ...key.split('/'));
}

export class LocalDocumentStorage implements DocumentStorage {
  async put(key: string, data: Buffer): Promise<void> {
    const path = documentKeyToDiskPath(key);
    if (!path) {
      throw new BadRequestException('Invalid document storage key');
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async download(key: string): Promise<DocumentDownload | null> {
    const path = documentKeyToDiskPath(key);
    if (!path) {
      throw new BadRequestException('Invalid document storage key');
    }
    try {
      const buffer = await readFile(path);
      return { kind: 'buffer', buffer };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    const path = documentKeyToDiskPath(key);
    if (!path) {
      return;
    }
    try {
      await unlink(path);
    } catch {
      // File already gone — nothing to clean up.
    }
  }
}

export interface SupabaseStorageConfig {
  url: string;
  serviceKey: string;
  bucket: string;
}

export class SupabaseDocumentStorage implements DocumentStorage {
  constructor(private readonly config: SupabaseStorageConfig) {}

  private objectUrl(path: 'object' | 'sign', key: string): string {
    const segment = path === 'sign' ? 'object/sign' : 'object';
    return `${this.config.url}/storage/v1/${segment}/${this.config.bucket}/${key}`;
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

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    const response = await fetch(this.objectUrl('object', key), {
      method: 'PUT',
      headers: this.authHeaders(mimeType),
      body: new Uint8Array(data),
    });
    if (!response.ok) {
      throw new Error(`Supabase Storage upload failed (${response.status})`);
    }
  }

  async download(key: string): Promise<DocumentDownload | null> {
    const response = await fetch(this.objectUrl('sign', key), {
      method: 'POST',
      headers: this.authHeaders('application/json'),
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    });
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`Supabase Storage sign failed (${response.status})`);
    }
    const payload = (await response.json()) as { signedURL?: string };
    if (!payload.signedURL) {
      throw new Error('Supabase Storage sign response missing signedURL');
    }
    return {
      kind: 'redirect',
      url: `${this.config.url}/storage/v1${payload.signedURL}`,
    };
  }

  async remove(key: string): Promise<void> {
    const response = await fetch(this.objectUrl('object', key), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(
        `Supabase Storage delete failed (${response.status})`,
      );
    }
  }
}

export function createDocumentStorage(
  env: DocumentStorageEnv = process.env,
): DocumentStorage {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && serviceKey) {
    return new SupabaseDocumentStorage({
      url,
      serviceKey,
      bucket: env.SUPABASE_STORAGE_BUCKET || DEFAULT_SUPABASE_BUCKET,
    });
  }
  return new LocalDocumentStorage();
}

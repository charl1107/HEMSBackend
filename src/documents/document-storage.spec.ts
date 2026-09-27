import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocumentStorage,
  documentKeyToDiskPath,
  LocalDocumentStorage,
  SupabaseDocumentStorage,
} from './document-storage.js';

describe('documentKeyToDiskPath', () => {
  it('maps safe keys under the documents root', () => {
    const path = documentKeyToDiskPath('evt-1/abc-123.pdf');
    expect(path?.replace(/\\/g, '/')).toContain('/stored-documents/evt-1/abc-123.pdf');
  });

  it('rejects traversal, absolute, and malformed keys', () => {
    expect(documentKeyToDiskPath('../etc/passwd')).toBeNull();
    expect(documentKeyToDiskPath('evt-1/../../etc/passwd')).toBeNull();
    expect(documentKeyToDiskPath('/etc/passwd')).toBeNull();
    expect(documentKeyToDiskPath('evt-1\\evil.pdf')).toBeNull();
    expect(documentKeyToDiskPath('evt-1/\0evil')).toBeNull();
    expect(documentKeyToDiskPath('')).toBeNull();
  });
});

describe('createDocumentStorage', () => {
  it('uses local disk when Supabase keys are absent', () => {
    expect(createDocumentStorage({})).toBeInstanceOf(LocalDocumentStorage);
    expect(
      createDocumentStorage({
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: '',
      }),
    ).toBeInstanceOf(LocalDocumentStorage);
  });

  it('uses Supabase Storage when both keys are present', () => {
    const storage = createDocumentStorage({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
      SUPABASE_STORAGE_BUCKET: 'my-bucket',
    });
    expect(storage).toBeInstanceOf(SupabaseDocumentStorage);
  });

  it('falls back to the default bucket name', () => {
    const storage = createDocumentStorage({
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    }) as SupabaseDocumentStorage;
    expect(storage).toBeInstanceOf(SupabaseDocumentStorage);
    expect(JSON.stringify(storage)).toContain('event-documents');
  });
});

describe('SupabaseDocumentStorage URL construction', () => {
  const config = {
    url: 'https://x.supabase.co',
    serviceKey: 'service-key',
    bucket: 'event-documents',
  };
  const KEY = 'evt-1/abc-123.pdf';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(
    response: { ok: boolean; status: number; json?: unknown },
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: async () => response.json ?? {},
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('sign (download) POSTs to /storage/v1/object/sign/{bucket}/{key}', async () => {
    const fetchMock = stubFetch({
      ok: true,
      status: 200,
      json: {
        signedURL: '/object/sign/event-documents/evt-1/abc-123.pdf?token=t',
      },
    });

    const result = await new SupabaseDocumentStorage(config).download(KEY);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://x.supabase.co/storage/v1/object/sign/event-documents/evt-1/abc-123.pdf',
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 300 });
    expect(result).toEqual({
      kind: 'redirect',
      url: 'https://x.supabase.co/storage/v1/object/sign/event-documents/evt-1/abc-123.pdf?token=t',
    });
  });

  it('put PUTs to /storage/v1/object/{bucket}/{key}', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });

    await new SupabaseDocumentStorage(config).put(KEY, Buffer.from('x'), 'application/pdf');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://x.supabase.co/storage/v1/object/event-documents/evt-1/abc-123.pdf',
    );
    expect(init.method).toBe('PUT');
  });

  it('remove DELETEs to /storage/v1/object/{bucket}/{key}', async () => {
    const fetchMock = stubFetch({ ok: true, status: 200 });

    await new SupabaseDocumentStorage(config).remove(KEY);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://x.supabase.co/storage/v1/object/event-documents/evt-1/abc-123.pdf',
    );
    expect(init.method).toBe('DELETE');
  });

  it('sign returns null only on 404 (object not found)', async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(
      new SupabaseDocumentStorage(config).download(KEY),
    ).resolves.toBeNull();
  });

  it('sign surfaces non-404 API failures as errors, not null', async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(
      new SupabaseDocumentStorage(config).download(KEY),
    ).rejects.toThrow('Supabase Storage sign failed (500)');
  });
});

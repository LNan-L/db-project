import { describe, expect, it, vi } from 'vitest';
import {
  BLOB_CHUNK_SIZE,
  downloadAttachmentBlob,
  downloadAttachmentBlobWithProgress,
  uploadAttachmentBlob
} from '../../src/sync/blobs';
import type { Attachment } from '../../src/storage/db';
import type { FetchLike, SyncConfig } from '../../src/sync/sync';

const config: SyncConfig = {
  serverUrl: 'http://sync.test/',
  token: 'x'.repeat(32),
  deviceId: 'device-test',
  deviceName: 'test',
  lastSyncAt: null,
  revisions: {}
};

function attachment(): Attachment {
  return {
    id: 'att-1',
    noteId: 'note-1',
    name: 'dot.png',
    mime: 'image/png',
    size: 4,
    hash: 'h',
    blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
    createdAt: '2026-11-11T00:00:00.000Z'
  };
}

describe('attachment blob transfer', () => {
  it('uploads with PUT, bearer auth and the blob body', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as FetchLike;
    const ok = await uploadAttachmentBlob(config, attachment(), fetchImpl);
    expect(ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/attachments/att-1/blob');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Bearer ${'x'.repeat(32)}`);
    expect(init.body).toBeInstanceOf(Blob);
  });

  it('uploads large blobs in chunks and resumes from the reported offset', async () => {
    // 服务端说已经收到一块，客户端应从第二块开始传（断点续传）
    const big = new Blob([new Uint8Array(BLOB_CHUNK_SIZE * 2 + 10)], { type: 'image/jpeg' });
    const att: Attachment = { ...attachment(), size: big.size, blob: big };

    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (!init || init.method !== 'PUT') {
        return new Response(JSON.stringify({ ok: true, complete: false, received: BLOB_CHUNK_SIZE }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ ok: true, complete: true }), { status: 200 });
    }) as unknown as FetchLike;

    const ok = await uploadAttachmentBlob(config, att, fetchImpl);
    expect(ok).toBe(true);

    const puts = calls.filter((call) => call.init?.method === 'PUT');
    // 从 1 块的位置续传，剩 1 块 + 10 字节 → 两块
    expect(puts).toHaveLength(2);
    expect(puts[0].init?.headers).toMatchObject({ 'X-PKE-Offset': String(BLOB_CHUNK_SIZE) });
    expect(puts[1].init?.headers).toMatchObject({ 'X-PKE-Offset': String(BLOB_CHUNK_SIZE * 2) });
    expect(puts[0].init?.headers).toMatchObject({ 'X-PKE-Total': String(big.size) });
  });

  it('retries a failed chunk instead of abandoning the whole upload', async () => {
    const big = new Blob([new Uint8Array(BLOB_CHUNK_SIZE + 5)], { type: 'image/jpeg' });
    const att: Attachment = { ...attachment(), size: big.size, blob: big };

    let puts = 0;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (!init || init.method !== 'PUT') {
        return new Response(JSON.stringify({ ok: true, complete: false, received: 0 }), { status: 200 });
      }
      puts += 1;
      // 第一块第一次失败，重试成功
      if (puts === 1) return new Response('{}', { status: 502 });
      return new Response(JSON.stringify({ ok: true, complete: true }), { status: 200 });
    }) as unknown as FetchLike;

    const ok = await uploadAttachmentBlob(config, att, fetchImpl);
    expect(ok).toBe(true);
    expect(puts).toBeGreaterThanOrEqual(3); // 失败 + 重试 + 第二块
  });

  it('downloads a blob and rebuilds the local attachment row', async () => {    const bytes = new Uint8Array([9, 8, 7]);
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })) as unknown as FetchLike;
    const row = await downloadAttachmentBlob(
      config,
      { id: 'att-1', noteId: 'note-1', name: 'dot.png', mime: 'image/png', hash: 'h' },
      fetchImpl
    );
    expect(row?.id).toBe('att-1');
    expect(row?.size).toBe(3);
    expect(row?.mime).toBe('image/png');
    const bytesBack = new Uint8Array(await row!.blob.arrayBuffer());
    expect([...bytesBack]).toEqual([9, 8, 7]);
  });

  it('returns null when the server has no blob', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 404 })) as unknown as FetchLike;
    const row = await downloadAttachmentBlob(
      config,
      { id: 'att-1', noteId: 'note-1', name: 'dot.png', mime: 'image/png', hash: 'h' },
      fetchImpl
    );
    expect(row).toBeNull();
  });

describe('attachment download progress', () => {
  it('reports byte progress while streaming the blob', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      }
    });
    const fetchImpl = vi.fn(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'image/png' } })
    ) as unknown as FetchLike;

    const seen: number[] = [];
    const row = await downloadAttachmentBlobWithProgress(
      config,
      { id: 'att-1', noteId: 'note-1', name: 'dot.png', mime: 'image/png', hash: 'h' },
      10,
      (loaded) => seen.push(loaded),
      fetchImpl
    );

    expect(seen).toEqual([2, 3]);
    expect(row?.size).toBe(3);
  });

  it('returns null when the blob request fails so the UI can offer retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as FetchLike;
    const row = await downloadAttachmentBlobWithProgress(
      config,
      { id: 'att-1', noteId: 'note-1', name: 'dot.png', mime: 'image/png', hash: 'h' },
      10,
      () => undefined,
      fetchImpl
    );
    expect(row).toBeNull();
  });
});
});
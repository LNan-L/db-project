/**
 * @req REQ-204 — 附件二进制传输。
 *
 * 元数据走 /api/v1/push && /pull，文件本体单独走：
 *   PUT /api/v1/attachments/:id/blob
 *   GET /api/v1/attachments/:id/blob
 * 慢链路上按需下载（打开笔记时才拉），不做全量预取。
 */
import type { Attachment } from '../storage/db';
import type { FetchLike, SyncConfig } from './sync';

export interface RemoteBlobMeta {
  id: string;
  noteId: string;
  name: string;
  mime: string;
  hash: string;
}

/** 分块大小：手机上行不稳，256 KB 的单块失败代价小、重传快。 */
export const BLOB_CHUNK_SIZE = 256 * 1024;
const UPLOAD_ATTEMPTS = 3;

function baseOf(config: SyncConfig): string {
  return config.serverUrl.replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BlobUploadStatus {
  complete: boolean;
  received: number;
}

/**
 * 问服务端这个附件已经收到多少字节。
 * 老服务端没有这个接口（404）时返回 null，调用方按"从头传"处理。
 */
async function probeBlobUpload(
  config: SyncConfig,
  attachmentId: string,
  fetchImpl: FetchLike
): Promise<BlobUploadStatus | null> {
  try {
    const response = await fetchImpl(
      `${baseOf(config)}/api/v1/attachments/${attachmentId}/blob/upload-status`,
      { headers: { Authorization: `Bearer ${config.token}` } }
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { complete?: boolean; received?: number };
    return {
      complete: body.complete === true,
      received: typeof body.received === 'number' && body.received > 0 ? body.received : 0
    };
  } catch {
    return null;
  }
}

/**
 * 上传附件字节。
 *
 * 小文件仍是一次 PUT；超过 BLOB_CHUNK_SIZE 走分块，并支持断点续传：
 * 先问服务端已收到多少，再从那个 offset 往后传。每块失败重试 3 次，
 * 网络抖动时不会把整包作废。
 */
export async function uploadAttachmentBlob(
  config: SyncConfig,
  attachment: Attachment,
  fetchImpl: FetchLike = fetch
): Promise<boolean> {
  const size = attachment.blob.size;
  if (size === 0) return false;
  const url = `${baseOf(config)}/api/v1/attachments/${attachment.id}/blob`;
  const mime = attachment.mime || 'application/octet-stream';

  if (size <= BLOB_CHUNK_SIZE) {
    const response = await fetchImpl(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': mime },
      body: attachment.blob
    });
    return response.ok;
  }

  const status = await probeBlobUpload(config, attachment.id, fetchImpl);
  if (status?.complete) return true;
  let offset = status?.received ?? 0;
  if (offset >= size) offset = 0;

  while (offset < size) {
    const end = Math.min(offset + BLOB_CHUNK_SIZE, size);
    const chunk = attachment.blob.slice(offset, end);
    let ok = false;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS && !ok; attempt += 1) {
      if (attempt > 0) await sleep(200 * attempt);
      try {
        const response = await fetchImpl(url, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': mime,
            'X-PKE-Offset': String(offset),
            'X-PKE-Total': String(size)
          },
          body: chunk
        });
        ok = response.ok;
      } catch {
        ok = false;
      }
    }
    if (!ok) return false;
    offset = end;
  }
  return true;
}

export type BlobProgress = (loaded: number, total: number) => void;

export async function downloadAttachmentBlobWithProgress(
  config: SyncConfig,
  meta: RemoteBlobMeta,
  totalHint: number,
  onProgress: BlobProgress,
  fetchImpl: FetchLike = fetch
): Promise<Attachment | null> {
  const response = await fetchImpl(baseOf(config) + '/api/v1/attachments/' + meta.id + '/blob', {
    headers: { Authorization: 'Bearer ' + config.token }
  });
  if (!response.ok) return null;
  const total = Number(response.headers.get('content-length')) || totalHint || 0;
  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, blob.size);
    return blob.size > 0 ? toAttachment(meta, blob) : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total || loaded);
    }
  }
  if (loaded === 0) return null;
  return toAttachment(meta, new Blob(chunks as unknown as BlobPart[], { type: meta.mime }));
}

function toAttachment(meta: RemoteBlobMeta, blob: Blob): Attachment {
  return {
    id: meta.id,
    noteId: meta.noteId,
    name: meta.name,
    mime: meta.mime || blob.type || 'application/octet-stream',
    size: blob.size,
    hash: meta.hash,
    blob,
    createdAt: new Date().toISOString()
  };
}

export async function downloadAttachmentBlob(
  config: SyncConfig,
  meta: RemoteBlobMeta,
  fetchImpl: FetchLike = fetch
): Promise<Attachment | null> {
  const response = await fetchImpl(`${baseOf(config)}/api/v1/attachments/${meta.id}/blob`, {
    headers: { Authorization: `Bearer ${config.token}` }
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  if (blob.size === 0) return null;
  return {
    id: meta.id,
    noteId: meta.noteId,
    name: meta.name,
    mime: meta.mime || blob.type || 'application/octet-stream',
    size: blob.size,
    hash: meta.hash,
    blob,
    createdAt: new Date().toISOString()
  };
}

/**
 * @req REQ-102 — 生产附件存储。
 * @req REQ-108 — 附件 hash 与导出/导入。
 */
import { db, type Attachment, type PkeDatabase } from './db';
import { newId } from '../lib/id';
import { sha256Hex } from '../migration/hash';
import { markTombstone } from './tombstones';

export async function listAttachments(
  noteId: string,
  database: PkeDatabase = db
): Promise<Attachment[]> {
  const rows = await database.attachments.where('noteId').equals(noteId).toArray();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllAttachments(
  database: PkeDatabase = db
): Promise<Attachment[]> {
  return database.attachments.toArray();
}

export async function addAttachment(
  noteId: string,
  file: File,
  database: PkeDatabase = db
): Promise<Attachment> {
  const source = new Uint8Array(await file.arrayBuffer());
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const hash = await sha256Hex(bytes);
  const attachment: Attachment = {
    id: newId(),
    noteId,
    name: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
    hash,
    blob: new Blob([bytes], { type: file.type || 'application/octet-stream' }),
    createdAt: new Date().toISOString()
  };
  await database.attachments.add(attachment);
  return attachment;
}

export async function removeAttachment(
  id: string,
  database: PkeDatabase = db
): Promise<void> {
  await database.transaction('rw', database.attachments, database.sync_tombstones, async () => {
    await markTombstone('attachment', id, database);
    await database.attachments.delete(id);
  });
}

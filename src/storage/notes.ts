/**
 * @req REQ-101 — 笔记 CRUD 生产实现。
 */
import { createNote, normalizeTags, type Note } from '../domain/note';
import { newId } from '../lib/id';
import { db, type PkeDatabase } from './db';

export async function listNotes(
  workspaceId = 'local',
  database: PkeDatabase = db
): Promise<Note[]> {
  const rows = await database.notes.where('workspaceId').equals(workspaceId).toArray();
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createStoredNote(
  input: Parameters<typeof createNote>[0] = {},
  database: PkeDatabase = db
): Promise<Note> {
  const note = createNote(input);
  await database.notes.add(note);
  return note;
}

export async function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'body' | 'tags' | 'folder'>>,
  database: PkeDatabase = db
): Promise<Note | undefined> {
  const current = await database.notes.get(id);
  if (!current) return undefined;
  const next: Note = {
    ...current,
    ...patch,
    tags: patch.tags ? normalizeTags(patch.tags) : current.tags,
    updatedAt: new Date().toISOString()
  };
  const changed =
    next.title !== current.title ||
    next.body !== current.body ||
    next.folder !== current.folder ||
    next.tags.length !== current.tags.length ||
    next.tags.some((tag, index) => tag !== current.tags[index]);
  if (!changed) return current;

  await database.transaction('rw', database.notes, database.note_versions, async () => {
    await database.note_versions.add({
      id: newId(),
      noteId: current.id,
      title: current.title,
      body: current.body,
      tags: current.tags,
      folder: current.folder,
      createdAt: current.updatedAt,
      source: 'save'
    });
    await database.notes.put(next);
  });
  return next;
}

export async function deleteNotes(
  ids: string[],
  database: PkeDatabase = db
): Promise<void> {
  if (ids.length === 0) return;
  await database.transaction(
    'rw',
    [
      database.notes,
      database.attachments,
      database.relations,
      database.note_versions,
      database.sync_tombstones,
      database.embeddings
    ],
    async () => {
      const attachments = await database.attachments.where('noteId').anyOf(ids).toArray();
      const bySource = await database.relations.where('sourceId').anyOf(ids).toArray();
      const byTarget = await database.relations.where('targetId').anyOf(ids).toArray();
      const now = new Date().toISOString();
      await database.sync_tombstones.bulkPut([
        ...ids.map((id) => ({ id: `note:${id}`, kind: 'note' as const, deletedAt: now })),
        ...attachments.map((row) => ({ id: `attachment:${row.id}`, kind: 'attachment' as const, deletedAt: now })),
        ...[...bySource, ...byTarget].map((row) => ({ id: `relation:${row.id}`, kind: 'relation' as const, deletedAt: now }))
      ]);
      await database.attachments.where('noteId').anyOf(ids).delete();
      await database.relations.where('sourceId').anyOf(ids).delete();
      await database.relations.where('targetId').anyOf(ids).delete();
      await database.note_versions.where('noteId').anyOf(ids).delete();
      // 删除笔记时同步清掉本地向量索引，避免关闭向量后残留明文。
      await database.embeddings.bulkDelete(ids);
      await database.notes.bulkDelete(ids);
    }
  );
}

export async function deleteNote(
  id: string,
  database: PkeDatabase = db
): Promise<void> {
  await deleteNotes([id], database);
}

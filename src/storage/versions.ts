/**
 * @req REQ-303 — 本地版本历史与恢复。
 */
import type { Note } from '../domain/note';
import { db, type NoteVersion, type PkeDatabase } from './db';
import { updateNote } from './notes';

export async function listVersions(
  noteId: string,
  database: PkeDatabase = db
): Promise<NoteVersion[]> {
  const rows = await database.note_versions.where('noteId').equals(noteId).toArray();
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function restoreVersion(
  version: NoteVersion,
  database: PkeDatabase = db
): Promise<Note | undefined> {
  return updateNote(
    version.noteId,
    {
      title: version.title,
      body: version.body,
      tags: version.tags,
      folder: version.folder
    },
    database
  );
}

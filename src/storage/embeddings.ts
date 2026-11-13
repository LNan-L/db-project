/**
 * @req REQ-301 — 本地向量索引的存储（只存本机，不参与同步/备份）。
 */
import { db, type NoteEmbedding, type PkeDatabase } from './db';

export async function listEmbeddings(database: PkeDatabase = db): Promise<NoteEmbedding[]> {
  return database.embeddings.toArray();
}

export async function embeddingsForModel(
  model: string,
  database: PkeDatabase = db
): Promise<NoteEmbedding[]> {
  return database.embeddings.where('model').equals(model).toArray();
}

export async function getEmbedding(
  noteId: string,
  database: PkeDatabase = db
): Promise<NoteEmbedding | undefined> {
  return database.embeddings.get(noteId);
}

export async function putEmbedding(
  row: NoteEmbedding,
  database: PkeDatabase = db
): Promise<void> {
  await database.embeddings.put(row);
}

export async function deleteEmbedding(
  noteId: string,
  database: PkeDatabase = db
): Promise<void> {
  await database.embeddings.delete(noteId);
}

export async function clearEmbeddings(database: PkeDatabase = db): Promise<void> {
  await database.embeddings.clear();
}

/** 切换嵌入模型后清理其它模型留下的旧行。 */
export async function clearEmbeddingsExceptModel(
  model: string,
  database: PkeDatabase = db
): Promise<void> {
  const staleKeys = await database.embeddings.where('model').notEqual(model).primaryKeys();
  if (staleKeys.length > 0) await database.embeddings.bulkDelete(staleKeys);
}

export async function countEmbeddings(
  model: string,
  database: PkeDatabase = db
): Promise<number> {
  return database.embeddings.where('model').equals(model).count();
}

/**
 * @req REQ-304 — 质量分析的处理动作（逐项确认后由面板调用）。
 */
import { db, type PkeDatabase } from '../storage/db';
import { deleteNote, updateNote } from '../storage/notes';
import { addManualRelation, listManualRelations, removeManualRelation } from '../storage/relations';

/** 合并重复：保留 keep，追加 drop 的正文、合并标签、迁移关系，然后删除 drop（带墓碑）。 */
export async function mergeDuplicateNotes(
  keepId: string,
  dropId: string,
  database: PkeDatabase = db
): Promise<void> {
  if (keepId === dropId) throw new Error('不能合并同一篇笔记');
  const keep = await database.notes.get(keepId);
  const drop = await database.notes.get(dropId);
  if (!keep || !drop) throw new Error('笔记不存在，可能已被删除');

  const mergedBody =
    drop.body.trim() && !keep.body.includes(drop.body.trim())
      ? `${keep.body.trim()}\n\n${drop.body.trim()}`.trim()
      : keep.body;
  const tags = [...new Set([...keep.tags, ...drop.tags])];
  await updateNote(keepId, { body: mergedBody, tags }, database);

  const relations = await listManualRelations(database);
  for (const relation of relations) {
    if (relation.sourceId !== dropId && relation.targetId !== dropId) continue;
    const other = relation.sourceId === dropId ? relation.targetId : relation.sourceId;
    if (other !== keepId) await addManualRelation(keepId, other, database);
    await removeManualRelation(relation.id, database);
  }

  await deleteNote(dropId, database);
}

/** 为断链创建一个空的目标笔记（标题即链接目标）。 */
export async function createMissingTarget(
  title: string,
  database: PkeDatabase = db
): Promise<string> {
  const clean = title.trim();
  if (!clean) throw new Error('链接目标为空');
  const { createStoredNote } = await import('../storage/notes');
  const note = await createStoredNote({ title: clean, body: '' }, database);
  return note.id;
}

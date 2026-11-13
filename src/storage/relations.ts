/**
 * @req REQ-106 — 手动关系；与显式双链区分。
 */
import { db, type ManualRelation, type PkeDatabase } from './db';
import { markTombstone } from './tombstones';

export function manualRelationId(a: string, b: string): string {
  const [source, target] = [a, b].sort();
  return `manual:${source}:${target}`;
}

export async function listManualRelations(
  database: PkeDatabase = db
): Promise<ManualRelation[]> {
  return database.relations.toArray();
}

export async function addManualRelation(
  sourceId: string,
  targetId: string,
  database: PkeDatabase = db
): Promise<ManualRelation> {
  if (sourceId === targetId) throw new Error('不能给自己建立手动关系');
  const id = manualRelationId(sourceId, targetId);
  const existing = await database.relations.get(id);
  if (existing) return existing;
  const [source, target] = [sourceId, targetId].sort();
  const relation: ManualRelation = {
    id,
    sourceId: source,
    targetId: target,
    createdAt: new Date().toISOString()
  };
  await database.relations.add(relation);
  return relation;
}

export async function removeManualRelation(
  id: string,
  database: PkeDatabase = db
): Promise<void> {
  await database.transaction('rw', database.relations, database.sync_tombstones, async () => {
    await markTombstone('relation', id, database);
    await database.relations.delete(id);
  });
}

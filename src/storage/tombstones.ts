/**
 * @req REQ-204 / REQ-303 — 删除墓碑。
 *
 * 本地删除后行本身没了，若不留墓碑，下次同步无法告诉服务端「这条被删了」，
 * 删除就永远传播不出去（也会被对端推回来）。墓碑在本端 push 成功后清除。
 */
import { db, type PkeDatabase, type SyncTombstone } from './db';

export type TombstoneKind = SyncTombstone['kind'];

export function tombstoneId(kind: TombstoneKind, id: string): string {
  return `${kind}:${id}`;
}

export function tombstoneTarget(tombstone: SyncTombstone): string {
  return tombstone.id.slice(tombstone.kind.length + 1);
}

export async function markTombstone(
  kind: TombstoneKind,
  id: string,
  database: PkeDatabase = db,
  now: Date = new Date()
): Promise<SyncTombstone> {
  const tombstone: SyncTombstone = {
    id: tombstoneId(kind, id),
    kind,
    deletedAt: now.toISOString()
  };
  await database.sync_tombstones.put(tombstone);
  return tombstone;
}

export async function listTombstones(
  kind: TombstoneKind,
  database: PkeDatabase = db
): Promise<SyncTombstone[]> {
  const rows = await database.sync_tombstones.where('kind').equals(kind).toArray();
  return rows.sort((a, b) => a.deletedAt.localeCompare(b.deletedAt));
}

export async function clearTombstones(
  ids: string[],
  database: PkeDatabase = db
): Promise<void> {
  if (ids.length === 0) return;
  await database.sync_tombstones.bulkDelete(ids);
}

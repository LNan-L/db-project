/**
 * @req REQ-602 — 最近导出时间等设置项。
 */
import { db, type PkeDatabase } from './db';

export async function getMetaValue(
  key: string,
  database: PkeDatabase = db
): Promise<string | null> {
  const record = await database.meta.get(key);
  return record?.value ?? null;
}

export async function setMetaValue(
  key: string,
  value: string,
  database: PkeDatabase = db
): Promise<void> {
  await database.meta.put({ key, value, updatedAt: new Date().toISOString() });
}

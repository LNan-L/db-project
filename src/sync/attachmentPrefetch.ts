/**
 * @req REQ-204 — Phase 4.6：附件批量预取与弱网开关。
 *
 * 打开笔记时把该篇缺失的附件一次补齐（旧的实现只拉前 3 个），但要守住两条线：
 * 并发 2、单篇总量 ≤10 MB；更大的附件留到手动下载。
 * 「弱网模式」写在 meta 里，关闭后打开笔记不再自动下载，只提示数量并提供手动下载。
 */
import { db, type PkeDatabase } from '../storage/db';
import { getMetaValue, setMetaValue } from '../storage/meta';

export const PREFETCH_TOTAL_BYTES = 10 * 1024 * 1024;
export const PREFETCH_CONCURRENCY = 2;
const MODE_KEY = 'attachment_prefetch';

export type PrefetchMode = 'auto' | 'off';

export async function loadPrefetchMode(database: PkeDatabase = db): Promise<PrefetchMode> {
  return (await getMetaValue(MODE_KEY, database)) === 'off' ? 'off' : 'auto';
}

export async function savePrefetchMode(
  mode: PrefetchMode,
  database: PkeDatabase = db
): Promise<void> {
  await setMetaValue(MODE_KEY, mode, database);
}

export interface PrefetchCandidate {
  id: string;
  size: number;
}

export interface PrefetchPlan {
  take: PrefetchCandidate[];
  /** 超出总量预算、留给手动下载的附件。 */
  skipped: PrefetchCandidate[];
  bytes: number;
}

export function planPrefetch(
  candidates: PrefetchCandidate[],
  budget = PREFETCH_TOTAL_BYTES
): PrefetchPlan {
  const take: PrefetchCandidate[] = [];
  const skipped: PrefetchCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const size = Number.isFinite(candidate.size) && candidate.size > 0 ? candidate.size : 0;
    if (bytes + size > budget) {
      skipped.push(candidate);
      continue;
    }
    take.push(candidate);
    bytes += size;
  }
  return { take, skipped, bytes };
}

/** 有界并发执行；结果顺序与输入一致。 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, Math.floor(limit)), items.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

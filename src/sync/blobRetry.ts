/**
 * @req REQ-204 — Phase 4.3：附件下载失败的自动退避重试。
 *
 * 失败后按 5s → 15s → 60s → 300s 自动重试；四次之后停手，保留手动重试。
 * 同一附件只保留一个待触发定时器（重复安排会替换旧的），避免叠加重试。
 */
export const BLOB_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];

/** 第 `attempt` 次失败后排下次重试的延迟（毫秒）；返回 null 表示不再自动重试。 */
export function retryDelayFor(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= BLOB_RETRY_DELAYS_MS.length) {
    return null;
  }
  return BLOB_RETRY_DELAYS_MS[attempt];
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleBlobRetry(id: string, attempt: number, run: () => void): number | null {
  cancelBlobRetry(id);
  const delay = retryDelayFor(attempt);
  if (delay === null) return null;
  const timer = setTimeout(() => {
    timers.delete(id);
    run();
  }, delay);
  timers.set(id, timer);
  return delay;
}

export function cancelBlobRetry(id: string): void {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

export function cancelAllBlobRetries(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}

export function pendingBlobRetries(): number {
  return timers.size;
}

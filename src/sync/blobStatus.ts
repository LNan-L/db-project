/**
 * @req REQ-204 — 附件下载失败状态的共享可见性。
 *
 * 编辑器里失败时登记到这里，同步面板据此显示「附件下载失败 + 重试」，
 * 点重试广播给所有打开的编辑器重新下载（并重置自动退避次数）。
 */
export interface BlobFailure {
  id: string;
  name: string;
  /** 已失败次数（用于展示与计算下一次退避）。 */
  attempts: number;
  /** 下一次自动重试的时间戳（epoch ms）；null 表示当前没有安排。 */
  nextRetryAt: number | null;
  /** 自动重试次数用完，只剩手动重试。 */
  exhausted: boolean;
}

export interface BlobFailureDetails {
  attempts?: number;
  nextRetryAt?: number | null;
  exhausted?: boolean;
}

const failures = new Map<string, BlobFailure>();
const stateListeners = new Set<(rows: BlobFailure[]) => void>();
const retryListeners = new Set<() => void>();

function snapshot(): BlobFailure[] {
  return [...failures.values()].map((row) => ({ ...row }));
}

function emit(): void {
  const rows = snapshot();
  for (const listener of stateListeners) listener(rows);
}

export function markBlobFailure(
  id: string,
  name: string,
  details: BlobFailureDetails = {}
): void {
  failures.set(id, {
    id,
    name,
    attempts: details.attempts ?? 0,
    nextRetryAt: details.nextRetryAt ?? null,
    exhausted: details.exhausted ?? false
  });
  emit();
}

export function clearBlobFailure(id: string): void {
  if (!failures.delete(id)) return;
  emit();
}

/** 笔记关闭 / 编辑器卸载：定时器已取消，展示上不要再写「自动重试中」。 */
export function pauseAllBlobRetries(): void {
  let changed = false;
  for (const row of failures.values()) {
    if (row.nextRetryAt !== null) {
      row.nextRetryAt = null;
      changed = true;
    }
  }
  if (changed) emit();
}

export function listBlobFailures(): BlobFailure[] {
  return snapshot();
}

export function subscribeBlobFailures(listener: (rows: BlobFailure[]) => void): () => void {
  stateListeners.add(listener);
  listener(snapshot());
  return () => {
    stateListeners.delete(listener);
  };
}

/** 手动重试：清空失败列表、重置退避计数，并通知编辑器重新下载。 */
export function requestBlobRetry(): void {
  failures.clear();
  emit();
  for (const listener of retryListeners) listener();
}

export function subscribeBlobRetry(listener: () => void): () => void {
  retryListeners.add(listener);
  return () => {
    retryListeners.delete(listener);
  };
}

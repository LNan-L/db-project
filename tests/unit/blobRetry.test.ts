import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOB_RETRY_DELAYS_MS,
  cancelAllBlobRetries,
  cancelBlobRetry,
  pendingBlobRetries,
  retryDelayFor,
  scheduleBlobRetry
} from '../../src/sync/blobRetry';

afterEach(() => {
  cancelAllBlobRetries();
  vi.useRealTimers();
});

describe('attachment retry backoff', () => {
  it('walks 5s / 15s / 60s / 300s then stops', () => {
    expect([0, 1, 2, 3, 4].map(retryDelayFor)).toEqual([...BLOB_RETRY_DELAYS_MS, null]);
    expect(BLOB_RETRY_DELAYS_MS).toEqual([5_000, 15_000, 60_000, 300_000]);
    expect(retryDelayFor(-1)).toBeNull();
    expect(retryDelayFor(1.5)).toBeNull();
  });

  it('fires after the delay and keeps only one timer per attachment', () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const second = vi.fn();
    scheduleBlobRetry('a', 0, first);
    scheduleBlobRetry('a', 0, second); // 同一附件重复安排会替换旧定时器
    expect(pendingBlobRetries()).toBe(1);

    vi.advanceTimersByTime(4_999);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(pendingBlobRetries()).toBe(0);
  });

  it('can be cancelled and refuses to schedule beyond the last delay', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    scheduleBlobRetry('b', 1, run);
    cancelBlobRetry('b');
    vi.advanceTimersByTime(15_000);
    expect(run).not.toHaveBeenCalled();

    expect(scheduleBlobRetry('c', 4, run)).toBeNull();
    expect(pendingBlobRetries()).toBe(0);
  });
});

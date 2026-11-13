import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBlobFailure,
  listBlobFailures,
  markBlobFailure,
  pauseAllBlobRetries,
  requestBlobRetry,
  subscribeBlobFailures,
  subscribeBlobRetry
} from '../../src/sync/blobStatus';

beforeEach(() => {
  requestBlobRetry();
});

describe('blob failure registry', () => {
  it('records attempts and the next auto-retry time', () => {
    markBlobFailure('a', 'x.png', { attempts: 2, nextRetryAt: 123_456, exhausted: false });
    const rows = listBlobFailures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'a',
      name: 'x.png',
      attempts: 2,
      nextRetryAt: 123_456,
      exhausted: false
    });

    clearBlobFailure('a');
    expect(listBlobFailures()).toEqual([]);
  });

  it('pauses pending retries without dropping the failure entry', () => {
    markBlobFailure('a', 'x.png', { attempts: 1, nextRetryAt: 9_999 });
    pauseAllBlobRetries();
    const rows = listBlobFailures();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nextRetryAt).toBeNull();
  });

  it('manual retry clears failures and notifies the open editor', () => {
    const notify = vi.fn();
    const unsubscribe = subscribeBlobRetry(notify);
    markBlobFailure('a', 'x.png');

    requestBlobRetry();

    expect(listBlobFailures()).toEqual([]);
    expect(notify).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('pushes snapshots to state subscribers', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeBlobFailures((rows) => seen.push(rows.length));
    markBlobFailure('a', 'x.png');
    markBlobFailure('a', 'x.png', { attempts: 1, nextRetryAt: 1 });

    expect(seen.at(-1)).toBe(1);
    unsubscribe();
  });
});

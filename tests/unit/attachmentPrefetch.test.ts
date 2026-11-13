import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import {
  loadPrefetchMode,
  planPrefetch,
  PREFETCH_TOTAL_BYTES,
  runWithConcurrency,
  savePrefetchMode
} from '../../src/sync/attachmentPrefetch';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-prefetch-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe('attachment prefetch planning', () => {
  it('takes what fits the byte budget and defers the rest, keeping order', () => {
    const plan = planPrefetch(
      [
        { id: 'a', size: 60 },
        { id: 'b', size: 50 },
        { id: 'c', size: 40 },
        { id: 'd', size: 0 }
      ],
      100
    );
    expect(plan.take.map((row) => row.id)).toEqual(['a', 'c', 'd']);
    expect(plan.skipped.map((row) => row.id)).toEqual(['b']);
    expect(plan.bytes).toBe(100);
  });

  it('defaults to a 10 MB per-note budget', () => {
    const plan = planPrefetch(
      [
        { id: 'small', size: 1024 },
        { id: 'big', size: PREFETCH_TOTAL_BYTES + 1 }
      ]
    );
    expect(plan.take.map((row) => row.id)).toEqual(['small']);
    expect(plan.skipped.map((row) => row.id)).toEqual(['big']);
  });

  it('runs at most `limit` tasks at a time and preserves result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('persists the weak-network mode flag', async () => {
    const database = makeDb();
    await ensureSchema(database);
    expect(await loadPrefetchMode(database)).toBe('auto');
    await savePrefetchMode('off', database);
    expect(await loadPrefetchMode(database)).toBe('off');
    await savePrefetchMode('auto', database);
    expect(await loadPrefetchMode(database)).toBe('auto');
  });
});

import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema, PkeDatabase } from '../../src/storage/db';
import { createStoredNote, deleteNote, updateNote } from '../../src/storage/notes';
import { addManualRelation, removeManualRelation } from '../../src/storage/relations';
import { syncNotes, type FetchLike, type SyncConfig } from '../../src/sync/sync';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-sync-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
  vi.unstubAllGlobals();
});

function config(): SyncConfig {
  return {
    serverUrl: 'http://sync.test',
    token: 'x'.repeat(32),
    deviceId: 'device-test',
    deviceName: 'test',
    lastSyncAt: null,
    revisions: {}
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('sync client', () => {
  it('pushes local notes and records revisions', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = await createStoredNote({ title: '同步', body: '正文' }, database);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/pull')) {
        return json({ ok: true, notes: [], serverTime: '2026-11-10T00:00:00.000Z' });
      }
      expect(url).toContain('/api/v1/push');
      expect(init?.method).toBe('POST');
      return json({
        ok: true,
        applied: [{ id: note.id, revision: 1 }],
        conflicts: [],
        serverTime: '2026-11-10T00:00:01.000Z'
      });
    }) as unknown as FetchLike;

    const result = await syncNotes(config(), database, fetchImpl);
    expect(result.pushed).toBe(1);
    expect(result.revisions[note.id]).toBe(1);
    expect(result.conflicts).toEqual([]);
  });

  it('detects a two-sided conflict without overwriting', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = await createStoredNote({ title: '冲突', body: '本地' }, database);
    await updateNote(note.id, { body: '本地新' }, database);
    const local = (await database.notes.get(note.id))!;
    const fetchImpl = vi.fn(async () =>
      json({
        ok: true,
        notes: [
          {
            id: note.id,
            title: '冲突',
            body: '远端新',
            tags: [],
            folder: '',
            updatedAt: local.updatedAt,
            revision: 2,
            device: 'other',
            deleted: false
          }
        ],
        serverTime: '2026-11-10T00:00:00.000Z'
      })
    ) as unknown as FetchLike;

    const result = await syncNotes(
      { ...config(), lastSyncAt: '2026-11-09T00:00:00.000Z', revisions: { [note.id]: 1 } },
      database,
      fetchImpl
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.remote.body).toBe('远端新');
    expect((await database.notes.get(note.id))?.body).toBe('本地新');
  });

describe('sync scope: relations, attachments, deletions', () => {
  it('pushes manual relations and clears the tombstone after a successful push', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const a = await createStoredNote({ title: 'A' }, database);
    const b = await createStoredNote({ title: 'B' }, database);
    const relation = await addManualRelation(a.id, b.id, database);

    const pushes: any[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/v1/pull')) {
        return json({ ok: true, notes: [], relations: [], attachments: [], serverTime: '2026-11-11T00:00:00.000Z' });
      }
      pushes.push(JSON.parse(String(init?.body)));
      return json({
        ok: true,
        applied: [a.id, b.id].map((id) => ({ id, revision: 1 })),
        conflicts: [],
        relationsApplied: 1,
        attachmentsApplied: 0,
        serverTime: '2026-11-11T00:00:01.000Z'
      });
    }) as unknown as FetchLike;

    const result = await syncNotes(config(), database, fetchImpl);
    expect(result.relationsPushed).toBe(1);
    const sent = pushes[0].relations as Array<{ id: string; deleted: boolean }>;
    expect(sent.map((row) => row.id)).toContain(relation.id);
    expect(sent.every((row) => row.deleted === false)).toBe(true);

    await removeManualRelation(relation.id, database);
    expect(await database.sync_tombstones.count()).toBe(1);

    await syncNotes({ ...config(), lastSyncAt: '2026-11-11T00:00:01.000Z' }, database, fetchImpl);
    const deleted = (pushes[1].relations as Array<{ id: string; deleted: boolean }>).filter((row) => row.deleted);
    expect(deleted.map((row) => row.id)).toContain(relation.id);
    expect(await database.sync_tombstones.count()).toBe(0);
  });

  it('pulls remote relations and attachment metadata', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const fetchImpl = vi.fn(async () =>
      json({
        ok: true,
        notes: [],
        relations: [
          { id: 'manual:n1:n2', sourceId: 'n1', targetId: 'n2', createdAt: '2026-11-11T00:00:00.000Z', deleted: false }
        ],
        attachments: [
          {
            id: 'att-1',
            noteId: 'n1',
            name: 'a.png',
            mime: 'image/png',
            size: 12,
            hash: 'abc',
            createdAt: '2026-11-11T00:00:00.000Z',
            deleted: false
          }
        ],
        serverTime: '2026-11-11T00:00:00.000Z'
      })
    ) as unknown as FetchLike;

    const result = await syncNotes({ ...config(), lastSyncAt: '2026-11-10T00:00:00.000Z' }, database, fetchImpl);
    expect(result.relationsPulled).toBe(1);
    expect(result.attachmentsPulled).toBe(1);
    expect((await database.relations.get('manual:n1:n2'))?.targetId).toBe('n2');
    // 只登记元数据，不伪造本地 blob。
    expect((await database.attachment_refs.get('att-1'))?.hash).toBe('abc');
    expect(await database.attachments.count()).toBe(0);
  });

  it('pushes note tombstones so deletions propagate', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = await createStoredNote({ title: '要删的' }, database);
    await deleteNote(note.id, database);
    expect(await database.sync_tombstones.count()).toBe(1);

    const pushes: any[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/v1/pull')) {
        return json({ ok: true, notes: [], relations: [], attachments: [], serverTime: '2026-11-11T00:00:00.000Z' });
      }
      pushes.push(JSON.parse(String(init?.body)));
      return json({
        ok: true,
        applied: [{ id: note.id, revision: 2 }],
        conflicts: [],
        relationsApplied: 0,
        attachmentsApplied: 0,
        serverTime: '2026-11-11T00:00:01.000Z'
      });
    }) as unknown as FetchLike;

    await syncNotes(config(), database, fetchImpl);
    const sentNotes = pushes[0].notes as Array<{ id: string; deleted?: boolean }>;
    expect(sentNotes.some((row) => row.id === note.id && row.deleted === true)).toBe(true);
    expect(await database.sync_tombstones.count()).toBe(0);
  });
});
  it('falls back to a full pull when the cursor is ahead of an empty local database', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return json({ ok: true, notes: [], relations: [], attachments: [], serverTime: '2026-11-11T00:00:00.000Z' });
    }) as unknown as FetchLike;

    await syncNotes({ ...config(), lastSyncAt: '2026-11-11T12:00:00.000Z' }, database, fetchImpl);

    expect(urls[0]).toContain('since=1970-01-01T00%3A00%3A00.000Z');
  });

  it('does not re-push attachments that predate the last sync', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = await createStoredNote({ title: 'attachments', body: 'body' }, database);
    await database.attachments.put({
      id: 'att-old',
      noteId: note.id,
      name: 'old.jpg',
      mime: 'image/jpeg',
      size: 3,
      hash: 'hash-old',
      blob: new Blob([]),
      createdAt: '2026-11-01T00:00:00.000Z'
    });
    await database.attachments.put({
      id: 'att-new',
      noteId: note.id,
      name: 'new.jpg',
      mime: 'image/jpeg',
      size: 3,
      hash: 'hash-new',
      blob: new Blob([]),
      createdAt: '2026-11-03T00:00:00.000Z'
    });

    const pushes: Array<{ attachments?: Array<{ id: string }> }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v1/pull')) {
        return json({
          ok: true,
          notes: [],
          relations: [],
          attachments: [],
          serverTime: '2026-11-02T00:00:00.000Z'
        });
      }
      pushes.push(JSON.parse(String(init?.body)));
      return json({
        ok: true,
        applied: [{ id: note.id, revision: 1 }],
        conflicts: [],
        serverTime: '2026-11-02T00:00:01.000Z'
      });
    }) as unknown as FetchLike;

    await syncNotes({ ...config(), lastSyncAt: '2026-11-02T00:00:00.000Z' }, database, fetchImpl);

    expect(pushes).toHaveLength(1);
    expect((pushes[0].attachments ?? []).map((row) => row.id)).toEqual(['att-new']);
  });

  it('turns a device-revoked 403 into an actionable message', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const fetchImpl = vi.fn(async () =>
      json({ ok: false, error: 'device-revoked', deviceId: 'device-test' }, 403)
    ) as unknown as FetchLike;

    await expect(syncNotes(config(), database, fetchImpl)).rejects.toThrow('本设备已被服务器撤销');
  });
});

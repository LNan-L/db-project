import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import { syncNotes, type SyncConfig, type FetchLike } from '../../src/sync/sync';
import { saveCanvasCard } from '../../src/storage/canvas';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-canvas-sync-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function config(lastSyncAt: string | null = null): SyncConfig {
  return {
    serverUrl: 'http://sync.test',
    token: 'x'.repeat(32),
    deviceId: 'dev-canvas',
    deviceName: 'test',
    lastSyncAt,
    revisions: {}
  };
}

describe('B-3 canvas sync (client)', () => {
  it('pulls remote cards and ignores ones older than local', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await saveCanvasCard('local-new', 10, 20, database);
    await database.canvas_cards.put({
      noteId: 'local-new',
      x: 10,
      y: 20,
      createdAt: '2026-11-12T10:00:00.000Z',
      updatedAt: '2026-11-12T10:00:00.000Z'
    });

    const fetchImpl = (async () =>
      json({
        notes: [],
        relations: [],
        attachments: [],
        canvas: [
          { noteId: 'remote-card', x: 300, y: 400, updatedAt: '2026-11-12T11:00:00.000Z' },
          { noteId: 'local-new', x: 999, y: 999, updatedAt: '2026-11-12T09:00:00.000Z' }
        ],
        serverTime: '2026-11-12T12:00:00.000Z'
      })) as unknown as FetchLike;

    const result = await syncNotes(config(), database, fetchImpl);
    expect(result.canvasPulled).toBe(1);
    const remote = await database.canvas_cards.get('remote-card');
    expect([remote?.x, remote?.y]).toEqual([300, 400]);
    const local = await database.canvas_cards.get('local-new');
    expect([local?.x, local?.y]).toEqual([10, 20]);
  });

  it('pushes only cards changed since the last sync', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await database.canvas_cards.put({
      noteId: 'old-card',
      x: 1,
      y: 2,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z'
    });
    await database.canvas_cards.put({
      noteId: 'new-card',
      x: 5,
      y: 6,
      createdAt: '2026-11-12T11:00:00.000Z',
      updatedAt: '2026-11-12T11:00:00.000Z'
    });

    let pushed: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pull')) {
        return json({ notes: [], relations: [], attachments: [], canvas: [], serverTime: '2026-11-12T12:00:00.000Z' });
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      pushed = body.canvas ?? [];
      return json({ applied: [], conflicts: [], relationsApplied: 0, attachmentsApplied: 0, canvasApplied: pushed.length, serverTime: '2026-11-12T12:00:00.000Z' });
    }) as unknown as FetchLike;

    const result = await syncNotes(config('2026-11-12T10:00:00.000Z'), database, fetchImpl);
    expect(pushed.map((card) => card.noteId)).toEqual(['new-card']);
    expect(result.canvasPushed).toBe(1);
  });

  it('sends no canvas field when nothing changed', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await database.canvas_cards.put({
      noteId: 'old-card',
      x: 1,
      y: 2,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z'
    });

    let body: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/pull')) {
        return json({ notes: [], relations: [], attachments: [], canvas: [], serverTime: '2026-11-12T12:00:00.000Z' });
      }
      body = JSON.parse(String(init?.body ?? '{}'));
      return json({ applied: [], conflicts: [], relationsApplied: 0, attachmentsApplied: 0, canvasApplied: 0, serverTime: '2026-11-12T12:00:00.000Z' });
    }) as unknown as FetchLike;

    await syncNotes(config('2026-11-12T10:00:00.000Z'), database, fetchImpl);
    // 没有待推送内容时不发 push（total === 0）
    expect(body).toBeNull();
  });
});

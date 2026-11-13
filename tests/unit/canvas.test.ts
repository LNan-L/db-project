import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import {
  listCanvasCards,
  loadCanvasViewport,
  pruneCanvasCards,
  removeCanvasCard,
  saveCanvasCard,
  saveCanvasViewport
} from '../../src/storage/canvas';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-canvas-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe('canvas storage', () => {
  it('saves, moves and lists cards with rounded coordinates', async () => {
    const database = makeDb();
    await ensureSchema(database);

    const created = await saveCanvasCard('note-a', 10.4, 20.6, database);
    expect(created).toMatchObject({ noteId: 'note-a', x: 10, y: 21 });
    expect(created.createdAt).toBeTruthy();

    const moved = await saveCanvasCard('note-a', 300, 400, database);
    expect(moved.createdAt).toBe(created.createdAt);
    const cards = await listCanvasCards(database);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ noteId: 'note-a', x: 300, y: 400 });
  });

  it('removes a single card and prunes cards whose notes are gone', async () => {
    const database = makeDb();
    await ensureSchema(database);
    await saveCanvasCard('a', 0, 0, database);
    await saveCanvasCard('b', 100, 0, database);
    await saveCanvasCard('c', 200, 0, database);

    await removeCanvasCard('c', database);
    expect((await listCanvasCards(database)).map((card) => card.noteId)).toEqual(['a', 'b']);

    const pruned = await pruneCanvasCards(new Set(['b']), database);
    expect(pruned).toBe(1);
    expect((await listCanvasCards(database)).map((card) => card.noteId)).toEqual(['b']);
  });

  it('upgrades a v5 database without losing notes or relations', async () => {
    const name = `pke-canvas-mig-${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(5).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      sync_tombstones: 'id, kind, deletedAt',
      attachment_refs: 'id, noteId, hash',
      meta: 'key'
    });
    await legacy.open();
    await legacy.table('notes').put({
      id: 'n1',
      workspaceId: 'local',
      title: '迁移前笔记',
      body: 'x',
      tags: [],
      folder: '',
      createdAt: 't',
      updatedAt: 't'
    });
    await legacy.table('relations').put({
      id: 'manual:n1:n2',
      sourceId: 'n1',
      targetId: 'n2',
      createdAt: 't'
    });
    legacy.close();

    names.push(name);
    const database = new PkeDatabase(name);
    instances.push(database);
    await database.open();
    expect(await database.notes.count()).toBe(1);
    expect(await database.relations.count()).toBe(1);
    expect(await database.canvas_cards.count()).toBe(0);
  });

  it('persists the viewport and rejects corrupt values', async () => {
    const database = makeDb();
    await ensureSchema(database);
    expect(await loadCanvasViewport(database)).toBeNull();

    await saveCanvasViewport({ x: -120, y: 40, k: 1.5 }, database);
    expect(await loadCanvasViewport(database)).toEqual({ x: -120, y: 40, k: 1.5 });

    await database.meta.put({ key: 'canvas_viewport', value: 'not-json', updatedAt: 'x' });
    expect(await loadCanvasViewport(database)).toBeNull();

    await database.meta.put({
      key: 'canvas_viewport',
      value: JSON.stringify({ x: 0, y: 0, k: 0 }),
      updatedAt: 'x'
    });
    expect(await loadCanvasViewport(database)).toBeNull();
  });
});

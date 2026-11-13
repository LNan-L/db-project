import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, PkeDatabase, SCHEMA_VERSION } from '../../src/storage/db';
import { createStoredNote, deleteNote, listNotes, updateNote } from '../../src/storage/notes';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-phase1-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) {
    try {
      database.close();
    } catch {
      // ignore
    }
  }
  for (const name of names.splice(0)) {
    await Dexie.delete(name);
  }
});

describe('phase 1 storage', () => {
  it('initializes schema and default workspace', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const workspace = await database.workspaces.get('local');
    expect(workspace?.name).toBe('本地知识库');
    const meta = await database.meta.get('schema_version');
    expect(meta?.value).toBe(String(SCHEMA_VERSION));
    database.close();
  });

  it('creates, updates, lists and deletes notes', async () => {
    const database = makeDb();
    await ensureSchema(database);

    const created = await createStoredNote(
      { title: '生产笔记', body: '正文', tags: ['pke'], folder: '项目' },
      database
    );
    expect(created.id).toBeTruthy();

    const updated = await updateNote(
      created.id,
      { title: '改名', body: '新正文', tags: ['#pke', 'x'] },
      database
    );
    expect(updated?.title).toBe('改名');
    expect(updated?.body).toBe('新正文');
    expect(updated?.tags).toEqual(['pke', 'x']);

    const list = await listNotes('local', database);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);

    await deleteNote(created.id, database);
    expect(await listNotes('local', database)).toHaveLength(0);
    database.close();
  });

  it('persists notes across reopen', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const created = await createStoredNote({ title: '持久化' }, database);
    database.close();

    const reopened = new PkeDatabase(database.name);
    await ensureSchema(reopened);
    const list = await listNotes('local', reopened);
    expect(list[0]?.id).toBe(created.id);
    expect(list[0]?.title).toBe('持久化');
    reopened.close();
  });
});

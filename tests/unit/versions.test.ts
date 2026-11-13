import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, PkeDatabase } from '../../src/storage/db';
import { createStoredNote, updateNote } from '../../src/storage/notes';
import { listVersions, restoreVersion } from '../../src/storage/versions';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-versions-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe('note versions', () => {
  it('snapshots previous content and restores it', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = await createStoredNote({ title: '版本', body: '一' }, database);
    await updateNote(note.id, { body: '二' }, database);
    await updateNote(note.id, { body: '三' }, database);

    const versions = await listVersions(note.id, database);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.some((version) => version.body === '一')).toBe(true);

    const target = versions.find((version) => version.body === '一')!;
    const restored = await restoreVersion(target, database);
    expect(restored?.body).toBe('一');
    expect((await database.notes.get(note.id))?.body).toBe('一');
    expect((await listVersions(note.id, database)).length).toBeGreaterThan(versions.length);
  });
});

import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import type { AiProvider } from '../../src/ai/provider';
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../../src/ai/settings';
import type { Note } from '../../src/domain/note';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import { embeddingsForModel } from '../../src/storage/embeddings';
import { buildBm25Index } from '../../src/search/bm25';
import { chunkNote, cosine, hybridSearch, mergeHybrid } from '../../src/search/vector';
import { ensureVectorIndex, rebuildVectorIndex } from '../../src/search/vectorIndex';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-vector-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

function makeNote(id: string, title: string, body: string, updatedAt = '2026-11-12T00:00:00.000Z'): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags: [],
    folder: '',
    createdAt: updatedAt,
    updatedAt
  };
}

function fakeVectors(text: string): number[] {
  if (/火星|红色星球/.test(text)) return [1, 0];
  if (/苹果/.test(text)) return [0, 1];
  return [0, 0];
}

function fakeProvider(): AiProvider {
  return {
    id: 'fake',
    kind: 'local',
    health: async () => true,
    embed: async (texts) => texts.map(fakeVectors),
    chat: async () => ''
  };
}

function settings(patch: Partial<AiSettings> = {}): AiSettings {
  return {
    ...DEFAULT_AI_SETTINGS,
    enabled: true,
    chat: { ...DEFAULT_AI_SETTINGS.chat },
    embedding: { ...DEFAULT_AI_SETTINGS.embedding, model: 'fake-embed' },
    ...patch
  };
}

describe('vector helpers', () => {
  it('chunks plain text with a size cap and strips markdown noise', () => {
    const body = `# 标题\n\n![图片](attachment:a1)\n\n${'火星'.repeat(400)}`;
    const chunks = chunkNote(body, 120, 5);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(chunks[0].text).not.toContain('attachment:');
    expect(chunks[0].text.length).toBeLessThanOrEqual(120);
  });

  it('computes cosine and fuses ranks', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);

    const merged = mergeHybrid(
      [{ noteId: 'a', score: 9, snippet: 'bm25 a' }],
      [
        { noteId: 'b', score: 0.9, snippet: 'vector b' },
        { noteId: 'a', score: 0.8, snippet: 'vector a' }
      ]
    );
    expect(merged.map((hit) => hit.noteId)).toEqual(['a', 'b']);
    expect(merged[0].via).toBe('both');
    expect(merged[1].via).toBe('vector');
    // 全文片段的可读性优先
    expect(merged[0].snippet).toBe('bm25 a');

    const manyBm25 = Array.from({ length: 25 }, (_, i) => ({ noteId: `z${i}`, score: 1, snippet: 's' }));
    const manyVector = Array.from({ length: 25 }, (_, i) => ({ noteId: `v${i}`, score: 1, snippet: 's' }));
    expect(mergeHybrid(manyBm25, manyVector)).toHaveLength(20);
    expect(mergeHybrid(manyBm25, manyVector).length).toBeLessThanOrEqual(20);

    const tie = mergeHybrid(
      [{ noteId: 'b', score: 2, snippet: 'b' }],
      [
        { noteId: 'c', score: 1, snippet: 'c' },
        { noteId: 'a', score: 1, snippet: 'a' }
      ]
    );
    expect(tie.map((hit) => hit.noteId)).toContain('a');
  });
});

describe('vector index', () => {
  it('builds incrementally, rebuilds when the note changes, and ignores up-to-date rows', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const provider = fakeProvider();
    const notes = [
      makeNote('a', '火星', '火星是太阳系第四颗行星'),
      makeNote('b', '苹果', '苹果是一种水果')
    ];

    const first = await ensureVectorIndex(notes, settings(), { provider, database });
    expect(first.indexed).toBe(2);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(2);

    const second = await ensureVectorIndex(notes, settings(), { provider, database });
    expect(second.indexed).toBe(0);

    const changed = [makeNote('a', '火星', '火星是太阳系第四颗行星', '2026-11-12T01:00:00.000Z'), notes[1]];
    const third = await ensureVectorIndex(changed, settings(), { provider, database });
    expect(third.indexed).toBe(1);

    await rebuildVectorIndex(notes, settings(), { provider, database });
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(2);
  });

  it('removes index rows for notes that no longer exist', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const provider = fakeProvider();
    const notes = [
      makeNote('a', '火星', '火星是太阳系第四颗行星'),
      makeNote('b', '苹果', '苹果是一种水果')
    ];
    await ensureVectorIndex(notes, settings(), { provider, database });
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(2);

    await ensureVectorIndex([notes[0]], settings(), { provider, database });
    const remaining = await embeddingsForModel('fake-embed', database);
    expect(remaining.map((row) => row.noteId)).toEqual(['a']);
  });

  it('marks provider failures without throwing the whole run', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const broken: AiProvider = {
      ...fakeProvider(),
      embed: async () => {
        throw new Error('offline');
      }
    };
    const stats = await ensureVectorIndex([makeNote('a', '火星', '火星')], settings(), {
      provider: broken,
      database
    });
    expect(stats.failed).toBe(1);
    expect(stats.lastError).toContain('offline');
    expect(stats.indexed).toBe(0);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(0);
  });

  it('does nothing when AI is disabled (fail-closed, no embedding calls)', async () => {
    const database = makeDb();
    await ensureSchema(database);
    let calls = 0;
    const provider = {
      ...fakeProvider(),
      embed: async (texts: string[]) => {
        calls += 1;
        return texts.map(fakeVectors);
      }
    };
    const stats = await ensureVectorIndex([makeNote('a', '火星', '火星')], settings({ enabled: false }), {
      provider,
      database
    });
    expect(stats.indexed).toBe(0);
    expect(calls).toBe(0);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(0);
  });

  it('keeps the old index when a rebuild fails', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const notes = [makeNote('a', '火星', '火星'), makeNote('b', '苹果', '苹果')];
    await ensureVectorIndex(notes, settings(), { provider: fakeProvider(), database });

    const broken: AiProvider = {
      ...fakeProvider(),
      embed: async () => {
        throw new Error('401 unauthorized');
      }
    };
    const stats = await rebuildVectorIndex(notes, settings(), { provider: broken, database });
    expect(stats.failed).toBeGreaterThan(0);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(2);
  });

  it('processes at most maxNotes per run and eventually covers the rest', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const provider = fakeProvider();
    const notes = Array.from({ length: 60 }, (_, i) => makeNote(`n${i}`, `笔记${i}`, `火星内容${i}`));

    const first = await ensureVectorIndex(notes, settings(), { provider, database, maxNotes: 50 });
    expect(first.indexed).toBe(50);
    const second = await ensureVectorIndex(notes, settings(), { provider, database, maxNotes: 50 });
    expect(second.indexed).toBe(10);
    const third = await ensureVectorIndex(notes, settings(), { provider, database, maxNotes: 50 });
    expect(third.indexed).toBe(0);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(60);
  });
});

describe('hybrid search (REQ-301)', () => {
  it('finds a semantic match that BM25 misses, and falls back to BM25 when vector is off', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const provider = fakeProvider();
    const notes = [
      makeNote('a', '火星笔记', '火星是太阳系第四颗行星'),
      makeNote('b', '苹果笔记', '苹果是一种水果')
    ];
    const index = buildBm25Index(notes);
    await ensureVectorIndex(notes, settings(), { provider, database });

    const hybrid = await hybridSearch('红色星球', index, settings({ vectorSearchEnabled: true }), provider, database);
    expect(hybrid.vectorUsed).toBe(true);
    expect(hybrid.hits[0].noteId).toBe('a');
    expect(hybrid.hits[0].via).toBe('vector');

    const off = await hybridSearch('红色星球', index, settings({ vectorSearchEnabled: false }), provider, database);
    expect(off.vectorUsed).toBe(false);
    expect(off.hits).toEqual([]);

    const broken = {
      ...provider,
      embed: async () => {
        throw new Error('offline');
      }
    };
    const fallback = await hybridSearch('苹果', index, settings({ vectorSearchEnabled: true }), broken, database);
    expect(fallback.vectorUsed).toBe(false);
    expect(fallback.hits[0].noteId).toBe('b');

    const disabled = await hybridSearch('苹果', index, settings({ vectorSearchEnabled: true, enabled: false }), provider, database);
    expect(disabled.vectorUsed).toBe(false);
    expect(disabled.reason).toContain('未启用');
    expect(disabled.hits[0].noteId).toBe('b');
  });

  it('surfaces provider errors and dimension mismatch as fallback reasons', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const notes = [makeNote('a', '火星', '火星是行星'), makeNote('b', '苹果', '苹果是水果')];
    const index = buildBm25Index(notes);
    const provider = fakeProvider();
    await ensureVectorIndex(notes, settings(), { provider, database });

    const unauthorized = {
      ...provider,
      embed: async () => {
        throw new Error('嵌入服务返回 401：invalid key');
      }
    };
    const failed = await hybridSearch('火星', index, settings({ vectorSearchEnabled: true }), unauthorized, database);
    expect(failed.vectorUsed).toBe(false);
    expect(failed.reason).toContain('401');

    const wrongDimension = {
      ...provider,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0])
    };
    const mismatch = await hybridSearch('火星', index, settings({ vectorSearchEnabled: true }), wrongDimension, database);
    expect(mismatch.vectorUsed).toBe(false);
    expect(mismatch.reason).toContain('维度');
    expect(mismatch.hits[0].noteId).toBe('a');
  });
});

describe('schema v7 migration', () => {
  it('keeps notes when upgrading a v6 database and starts with an empty index', async () => {
    const name = `pke-vector-mig-${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(6).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      sync_tombstones: 'id, kind, deletedAt',
      attachment_refs: 'id, noteId, hash',
      canvas_cards: 'noteId',
      meta: 'key'
    });
    await legacy.open();
    await legacy.table('notes').put(makeNote('n1', '旧笔记', '内容'));
    await legacy.table('relations').put({ id: 'manual:n1:n2', sourceId: 'n1', targetId: 'n2', createdAt: 't' });
    await legacy.table('canvas_cards').put({ noteId: 'n1', x: 1, y: 2, createdAt: 't', updatedAt: 't' });
    legacy.close();

    names.push(name);
    const database = new PkeDatabase(name);
    instances.push(database);
    await database.open();
    expect(await database.notes.count()).toBe(1);
    expect(await database.relations.count()).toBe(1);
    expect(await database.canvas_cards.count()).toBe(1);
    expect(await database.embeddings.count()).toBe(0);
    expect(database.tables.map((table) => table.name)).toContain('embeddings');
  });
});

describe('deleting a note', () => {
  it('removes its vector index rows', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const note = makeNote('a', '火星', '火星是行星');
    await database.notes.put(note);
    await ensureVectorIndex([note], settings(), { provider: fakeProvider(), database });
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(1);

    const { deleteNote } = await import('../../src/storage/notes');
    await deleteNote('a', database);
    expect((await embeddingsForModel('fake-embed', database)).length).toBe(0);
  });
});

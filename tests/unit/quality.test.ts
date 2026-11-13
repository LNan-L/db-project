import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import type { ManualRelation } from '../../src/storage/db';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import { createStoredNote } from '../../src/storage/notes';
import { addManualRelation } from '../../src/storage/relations';
import { createMissingTarget, mergeDuplicateNotes } from '../../src/quality/actions';
import { analyzeQuality } from '../../src/quality/analyze';

function note(id: string, title: string, body: string, tags: string[] = []): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags,
    folder: '',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z'
  };
}

function relation(a: string, b: string): ManualRelation {
  const [source, target] = [a, b].sort();
  return {
    id: `manual:${source}:${target}`,
    sourceId: source,
    targetId: target,
    createdAt: '2026-11-12T00:00:00.000Z'
  };
}

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-quality-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) database.close();
  for (const name of names.splice(0)) await Dexie.delete(name);
});

describe('quality analysis', () => {
  it('finds duplicates by identical title and by similar long content', () => {
    const report = analyzeQuality(
      [
        note('a', '重复标题', '完全一样的内容'),
        note('b', '重复标题', '完全一样的内容'),
        note(
          'c',
          '同步方案 A',
          '同步用于多端保持一致，备份用于历史副本，两者要配合使用并定期演练。'
        ),
        note(
          'd',
          '同步方案 B',
          '同步用于多端保持一致，备份用于历史副本，两者要配合使用并定期演练。'
        ),
        note('e', '完全无关', '这是一篇关于咖啡豆烘焙的笔记，和同步没有关系。')
      ],
      []
    );
    const titles = report.duplicates.map((pair) => `${pair.keepTitle}|${pair.dropTitle}`);
    expect(titles).toContain('重复标题|重复标题');
    expect(titles.some((pair) => pair.includes('同步方案'))).toBe(true);
    expect(titles.some((pair) => pair.includes('完全无关'))).toBe(false);
    expect(report.summary.duplicates).toBeGreaterThanOrEqual(2);
  });

  it('does not pair unrelated short notes even when bodies are empty', () => {
    const report = analyzeQuality([note('a', '未命名笔记', ''), note('b', '未命名笔记', '')], []);
    // 标题相同是明确的重复信号，这条允许；不同标题的空笔记不应配对。
    const other = analyzeQuality([note('a', '未命名笔记', ''), note('b', '另一篇', '')], []);
    expect(other.duplicates).toHaveLength(0);
    expect(report.duplicates).toHaveLength(1);
  });

  it('treats notes as linked when they have a relation, outgoing or incoming wikilink', () => {
    const notes = [
      note('a', '源', '见 [[目标]]'),
      note('b', '目标', '被引用'),
      note('c', '有关系的', '关系篇'),
      note('d', '孤立的', '谁也没提到我'),
      note('e', '关系另一端', '手动关系')
    ];
    const report = analyzeQuality(notes, [relation('c', 'e')]);
    const orphanIds = report.orphans.map((row) => row.id);
    expect(orphanIds).toContain('d');
    expect(orphanIds).not.toContain('a');
    expect(orphanIds).not.toContain('b');
    expect(orphanIds).not.toContain('c');
    expect(orphanIds).not.toContain('e');
  });

  it('reports broken links and ignores resolved links and code blocks', () => {
    const report = analyzeQuality(
      [
        note('a', '源', '见 [[存在的]] 和 [[不存在]]'),
        note('b', '存在的', 'ok'),
        note('c', '代码', '```\n[[不解析]]\n```')
      ],
      []
    );
    expect(report.brokenLinks.map((row) => row.target)).toEqual(['不存在']);
    expect(report.summary.brokenLinks).toBe(1);
  });

  it('treats a note whose only link is broken as an orphan', () => {
    const report = analyzeQuality([note('a', '只有断链', '见 [[没有的]]')], []);
    expect(report.brokenLinks).toHaveLength(1);
    expect(report.orphans.map((row) => row.id)).toEqual(['a']);
  });
});

describe('quality actions', () => {
  it('merges duplicates: body/tags combined, relations moved, drop deleted', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const keep = await createStoredNote(
      { title: '重复', body: '主内容', tags: ['a'] },
      database
    );
    const drop = await createStoredNote(
      { title: '重复', body: '附加内容', tags: ['b'] },
      database
    );
    const other = await createStoredNote({ title: '别的', body: 'x' }, database);
    await addManualRelation(drop.id, other.id, database);

    await mergeDuplicateNotes(keep.id, drop.id, database);

    const merged = await database.notes.get(keep.id);
    expect(merged?.body).toContain('主内容');
    expect(merged?.body).toContain('附加内容');
    expect(merged?.tags.sort()).toEqual(['a', 'b']);
    expect(await database.notes.get(drop.id)).toBeUndefined();
    // 手动关系两端按 id 排序存储，方向不固定；只断言「两者之间有且只有一条关系」。
    const relations = await database.relations.toArray();
    const endpoints = (row: { sourceId: string; targetId: string }) =>
      [row.sourceId, row.targetId].sort().join('|');
    const expected = [keep.id, other.id].sort().join('|');
    expect(relations.filter((row) => endpoints(row) === expected)).toHaveLength(1);
    expect(relations.some((row) => row.sourceId === drop.id || row.targetId === drop.id)).toBe(
      false
    );
    // 合并的删除走墓碑（主键 note:<id>），才能同步出去。
    const tombstone = await database.sync_tombstones.get(`note:${drop.id}`);
    expect(tombstone?.kind).toBe('note');
  });

  it('creates a missing link target', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const id = await createMissingTarget('新的目标', database);
    const created = await database.notes.get(id);
    expect(created?.title).toBe('新的目标');
    expect(created?.body).toBe('');
  });
});

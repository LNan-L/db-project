import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import { buildBm25Index, searchBm25, tokenize } from '../../src/search/bm25';

function note(id: string, title: string, body: string, tags: string[] = []): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags,
    folder: '',
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z'
  };
}

describe('production BM25', () => {
  it('tokenizes Chinese and English', () => {
    const tokens = tokenize('PKE 第一周施工 alpha');
    expect(tokens).toContain('alpha');
    expect(tokens.length).toBeGreaterThan(2);
  });

  it('finds notes by title, body and tags', () => {
    const index = buildBm25Index([
      note('a', '项目计划', 'PKE 第一周施工顺序', ['pke']),
      note('b', '会议记录', '讨论 alpha 检索')
    ]);
    expect(searchBm25(index, '项目').map((hit) => hit.noteId)).toContain('a');
    expect(searchBm25(index, '施工').map((hit) => hit.noteId)).toContain('a');
    expect(searchBm25(index, 'alpha').map((hit) => hit.noteId)).toContain('b');
    expect(searchBm25(index, 'pke').map((hit) => hit.noteId)).toContain('a');
    expect(searchBm25(index, 'zzz-not-found')).toEqual([]);
  });

  it('rebuilds from note bodies', () => {
    const original = note('a', '项目计划', '施工顺序');
    expect(searchBm25(buildBm25Index([original]), '施工')).toHaveLength(1);
    const changed = { ...original, body: '已经换掉' };
    expect(searchBm25(buildBm25Index([changed]), '施工')).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const index = buildBm25Index([note('a', '标题', '正文')]);
    expect(searchBm25(index, '   ')).toEqual([]);
  });
});

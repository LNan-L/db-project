import { describe, expect, it } from 'vitest';
import { createNote, normalizeTags } from '../../src/domain/note';

describe('note domain', () => {
  it('creates a note with defaults', () => {
    const note = createNote({ now: new Date('2026-11-08T00:00:00.000Z') });
    expect(note.id).toBeTruthy();
    expect(note.title).toBe('未命名笔记');
    expect(note.workspaceId).toBe('local');
    expect(note.body).toBe('');
    expect(note.tags).toEqual([]);
    expect(note.folder).toBe('');
    expect(note.createdAt).toBe('2026-11-08T00:00:00.000Z');
    expect(note.updatedAt).toBe(note.createdAt);
  });

  it('normalizes title, folder, tags and ids', () => {
    const note = createNote({
      id: 'stable-id',
      title: '  标题  ',
      folder: '  项目  ',
      tags: ['#pke', 'pke', ' two words ', '项目']
    });
    expect(note.id).toBe('stable-id');
    expect(note.title).toBe('标题');
    expect(note.folder).toBe('项目');
    expect(note.tags).toEqual(['pke', '项目']);
  });

  it('deduplicates tags in order', () => {
    expect(normalizeTags(['a', '#a', 'b', 'b'])).toEqual(['a', 'b']);
  });
});

import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import {
  buildLinkIndex,
  getBacklinks,
  getOutgoingLinks,
  normalizeWikiLinkMarkdown,
  parseWikiLinks,
  resolveTarget
} from '../../src/domain/wikiLinks';

function note(id: string, title: string, body: string): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags: [],
    folder: '',
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z'
  };
}

describe('production wikilinks', () => {
  it('parses title and id+label links', () => {
    const links = parseWikiLinks('a [[目标]] b [[id-1|显示名]]');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ target: '目标', label: '目标' });
    expect(links[1]).toMatchObject({ target: 'id-1', label: '显示名' });
  });

  it('ignores code blocks and inline code', () => {
    const links = parseWikiLinks('```\n[[代码]]\n```\n`[[行内]]` [[正文]]');
    expect(links).toHaveLength(1);
    expect(links[0]?.target).toBe('正文');
  });

  it('normalizes escaped brackets from the Markdown serializer', () => {
    expect(normalizeWikiLinkMarkdown('参考 \\[\\[目标]]')).toBe('参考 [[目标]]');
  });

  it('resolves by stable id and title', () => {
    const target = note('id-target', '目标', '');
    const source = note('id-source', '来源', '[[目标]]');
    const index = buildLinkIndex([target, source]);
    expect(resolveTarget(index, 'id-target').noteId).toBe('id-target');
    expect(resolveTarget(index, '目标').noteId).toBe('id-target');
    expect(getOutgoingLinks(source, index)[0]?.noteId).toBe('id-target');
  });

  it('does not guess duplicate titles', () => {
    const index = buildLinkIndex([note('a', '同名', ''), note('b', '同名', '')]);
    const resolved = resolveTarget(index, '同名');
    expect(resolved.noteId).toBeNull();
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.broken).toBe(false);
  });

  it('derives backlinks from body text', () => {
    const target = note('target', '目标', '');
    const source = note('source', '来源', '参考 [[目标]]');
    const other = note('other', '无关', '');
    const index = buildLinkIndex([target, source, other]);
    const backlinks = getBacklinks(target, [target, source, other], index);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]?.note.id).toBe('source');
  });
});

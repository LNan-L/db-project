/**
 * @req REQ-104 — 生产标签工具。
 */
import type { Note } from './note';

export function normalizeTag(input: string): string | null {
  const tag = input.trim().replace(/^#+/, '').trim();
  if (!tag || /\s/.test(tag)) return null;
  return tag;
}

export function addTag(tags: string[], input: string): string[] {
  const tag = normalizeTag(input);
  if (!tag || tags.includes(tag)) return tags;
  return [...tags, tag];
}

export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((item) => item !== tag);
}

export function collectTags(notes: Note[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, 'zh-CN'));
}

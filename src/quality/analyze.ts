/**
 * @req REQ-304 — 知识质量分析：重复 / 孤立 / 断链。
 *
 * 纯函数、无 IO；面板只负责展示与逐项确认。重复判定刻意保守：
 * 标题相同，或「标题相似 + 正文相似」同时成立，避免把无关短笔记配成一对。
 */
import type { Note } from '../domain/note';
import type { ManualRelation } from '../storage/db';
import {
  buildLinkIndex,
  getOutgoingLinks,
  normalizeWikiLinkMarkdown,
  parseWikiLinks,
  resolveTarget
} from '../domain/wikiLinks';

export interface DuplicatePair {
  keepId: string;
  dropId: string;
  keepTitle: string;
  dropTitle: string;
  score: number;
  reason: 'same-title' | 'similar-content';
}

export interface OrphanNote {
  id: string;
  title: string;
}

export interface BrokenLink {
  sourceId: string;
  sourceTitle: string;
  target: string;
}

export interface QualityReport {
  duplicates: DuplicatePair[];
  orphans: OrphanNote[];
  brokenLinks: BrokenLink[];
  summary: {
    notes: number;
    duplicates: number;
    orphans: number;
    brokenLinks: number;
  };
}

function normalizeTitle(title: string): string {
  return title.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}

function tokenize(text: string): Set<string> {
  const lower = text.toLocaleLowerCase();
  const tokens = lower.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function similarity(a: Note, b: Note): { title: number; body: number; score: number } {
  const title = jaccard(tokenize(a.title), tokenize(b.title));
  const body = jaccard(tokenize(a.body), tokenize(b.body));
  return { title, body, score: Number((title * 0.5 + body * 0.5).toFixed(3)) };
}

export function analyzeQuality(notes: Note[], relations: ManualRelation[]): QualityReport {
  const index = buildLinkIndex(notes);
  const duplicates: DuplicatePair[] = [];
  const seenPairs = new Set<string>();

  const pushPair = (a: Note, b: Note, score: number, reason: DuplicatePair['reason']) => {
    const [first, second] = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    if (!first || !second) return;
    const key = `${first.id}:${second.id}`;
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    duplicates.push({
      keepId: first.id,
      dropId: second.id,
      keepTitle: first.title,
      dropTitle: second.title,
      score,
      reason
    });
  };

  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = notes[i]!;
      const b = notes[j]!;
      const sameTitle =
        normalizeTitle(a.title) !== '' && normalizeTitle(a.title) === normalizeTitle(b.title);
      const { title, body, score } = similarity(a, b);
      if (sameTitle) {
        pushPair(a, b, Math.max(score, 1), 'same-title');
        continue;
      }
      const longEnough = a.body.trim().length >= 20 && b.body.trim().length >= 20;
      if (longEnough && title >= 0.7 && body >= 0.5) {
        pushPair(a, b, score, 'similar-content');
      } else if (longEnough && body >= 0.85 && title >= 0.3) {
        pushPair(a, b, score, 'similar-content');
      }
    }
  }
  duplicates.sort((a, b) => b.score - a.score || a.keepId.localeCompare(b.keepId));

  const relationIds = new Set<string>();
  for (const relation of relations) {
    relationIds.add(relation.sourceId);
    relationIds.add(relation.targetId);
  }
  const linked = new Set<string>(relationIds);
  for (const note of notes) {
    // 只有「至少一条解析成功的出链」才算有出链；全是断链的来源仍是孤立。
    let hasResolvedOutgoing = false;
    for (const resolved of getOutgoingLinks(note, index)) {
      if (!resolved.noteId) continue;
      hasResolvedOutgoing = true;
      linked.add(resolved.noteId);
    }
    if (hasResolvedOutgoing) linked.add(note.id);
  }

  const orphans: OrphanNote[] = notes
    .filter((note) => !linked.has(note.id))
    .map((note) => ({ id: note.id, title: note.title }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const brokenLinks: BrokenLink[] = [];
  const seenBroken = new Set<string>();
  for (const note of notes) {
    for (const link of parseWikiLinks(normalizeWikiLinkMarkdown(note.body))) {
      const resolved = resolveTarget(index, link.target, link.label);
      if (!resolved.broken) continue;
      const key = `${note.id}:${link.target}`;
      if (seenBroken.has(key)) continue;
      seenBroken.add(key);
      brokenLinks.push({ sourceId: note.id, sourceTitle: note.title, target: link.target });
    }
  }
  brokenLinks.sort(
    (a, b) => a.sourceTitle.localeCompare(b.sourceTitle) || a.target.localeCompare(b.target)
  );

  return {
    duplicates,
    orphans,
    brokenLinks,
    summary: {
      notes: notes.length,
      duplicates: duplicates.length,
      orphans: orphans.length,
      brokenLinks: brokenLinks.length
    }
  };
}

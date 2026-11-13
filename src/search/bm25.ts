/**
 * @req REQ-202（Phase 1 生产实现）— 本地 BM25 搜索。
 */
import type { Note } from '../domain/note';

export interface SearchHit {
  noteId: string;
  score: number;
  snippet: string;
}

interface IndexedDoc {
  note: Note;
  length: number;
}

export interface Bm25Index {
  docs: Map<string, IndexedDoc>;
  postings: Map<string, Map<string, number>>;
  avgdl: number;
}

let segmenter: Intl.Segmenter | null = null;
try {
  segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
} catch {
  segmenter = null;
}

export function tokenize(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase();
  if (segmenter) {
    const tokens: string[] = [];
    for (const part of segmenter.segment(normalized)) {
      if (!part.isWordLike) continue;
      const token = part.segment.trim();
      if (token) tokens.push(token);
    }
    return tokens;
  }

  const chunks = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const chunk of chunks) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      const chars = Array.from(chunk);
      tokens.push(...chars);
      for (let i = 0; i < chars.length - 1; i += 1) tokens.push(`${chars[i]}${chars[i + 1]}`);
    } else {
      tokens.push(chunk);
    }
  }
  return tokens;
}

export function buildBm25Index(notes: Note[]): Bm25Index {
  const docs = new Map<string, IndexedDoc>();
  const postings = new Map<string, Map<string, number>>();
  let totalLength = 0;

  for (const note of notes) {
    const counts = new Map<string, number>();
    const add = (tokens: string[], weight: number) => {
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + weight);
    };
    add(tokenize(note.title), 3);
    add(note.tags.flatMap((tag) => tokenize(tag)), 2);
    add(tokenize(note.body), 1);

    const length = [...counts.values()].reduce((sum, value) => sum + value, 0) || 1;
    totalLength += length;
    docs.set(note.id, { note, length });

    for (const [token, tf] of counts) {
      const posting = postings.get(token) ?? new Map<string, number>();
      posting.set(note.id, tf);
      postings.set(token, posting);
    }
  }

  return { docs, postings, avgdl: docs.size > 0 ? totalLength / docs.size : 0 };
}

function makeSnippet(note: Note, terms: string[]): string {
  const text = note.body || note.title;
  const lower = text.toLocaleLowerCase();
  for (const term of terms) {
    const index = lower.indexOf(term.toLocaleLowerCase());
    if (index >= 0) {
      const start = Math.max(0, index - 36);
      const end = Math.min(text.length, index + 84);
      return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
    }
  }
  return `${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`;
}

export function searchBm25(index: Bm25Index, query: string, limit = 20): SearchHit[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.docs.size === 0) return [];

  const k1 = 1.2;
  const b = 0.75;
  const totalDocs = index.docs.size;
  const scores = new Map<string, number>();

  for (const term of terms) {
    const posting = index.postings.get(term);
    if (!posting || posting.size === 0) continue;
    const df = posting.size;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    for (const [noteId, tf] of posting) {
      const doc = index.docs.get(noteId);
      if (!doc) continue;
      const denominator = tf + k1 * (1 - b + (b * doc.length) / (index.avgdl || 1));
      scores.set(noteId, (scores.get(noteId) ?? 0) + idf * ((tf * (k1 + 1)) / denominator));
    }
  }

  return [...scores.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, limit)
    .map(([noteId, score]) => {
      const note = index.docs.get(noteId)!.note;
      return { noteId, score, snippet: makeSnippet(note, terms) };
    });
}

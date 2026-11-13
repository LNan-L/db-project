/**
 * @req REQ-301 — 向量检索：切块、余弦、RRF 融合与 BM25 回退。
 *
 * 回退是硬要求：AI 未启用、向量关闭、索引为空、provider 报错、维度不一致，
 * 一律返回 BM25 结果并给出 `reason`，UI 只在混合真正跑通时标「混合检索」。
 */
import type { AiProvider } from '../ai/provider';
import type { AiSettings } from '../ai/settings';
import type { NoteEmbedding } from '../storage/db';
import { db, type PkeDatabase } from '../storage/db';
import { embeddingsForModel } from '../storage/embeddings';
import { searchBm25, type Bm25Index, type SearchHit } from './bm25';

export interface Chunk {
  text: string;
  offset: number;
}

/** 去掉 Markdown 标记，让嵌入更接近自然语言。 */
export function stripMarkdown(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function chunkNote(body: string, maxChars = 500, maxChunks = 20): Chunk[] {
  const text = stripMarkdown(body);
  if (!text) return [];
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    let end = Math.min(text.length, start + maxChars);
    if (end < text.length) {
      const window = text.slice(start, end);
      const boundary = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('.')
      );
      if (boundary > maxChars * 0.5) end = start + boundary + 1;
    }
    if (end <= start) break;
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push({ text: piece, offset: start });
    start = end;
  }
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function snippetFrom(text: string, max = 100): string {
  const plain = stripMarkdown(text);
  return plain.length > max ? `${plain.slice(0, max)}…` : plain || '（空正文）';
}

/** 用查询向量对已建索引打分；同分按 noteId 稳定排序。 */
export function rankByVector(
  rows: NoteEmbedding[],
  queryVector: number[],
  limit = 20
): SearchHit[] {
  const best = new Map<string, { score: number; text: string }>();
  for (const row of rows) {
    for (const chunk of row.chunks) {
      const score = cosine(queryVector, chunk.vector);
      if (score <= 0) continue;
      const current = best.get(row.noteId);
      if (!current || score > current.score) best.set(row.noteId, { score, text: chunk.text });
    }
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([noteId, value]) => ({
      noteId,
      score: value.score,
      snippet: snippetFrom(value.text)
    }));
}

export interface HybridHit extends SearchHit {
  via: 'bm25' | 'vector' | 'both';
}

/** Reciprocal Rank Fusion：按名次融合，不依赖两路分数量纲。 */
export function mergeHybrid(
  bm25Hits: SearchHit[],
  vectorHits: SearchHit[],
  k = 60,
  limit = 20
): HybridHit[] {
  const merged = new Map<
    string,
    { noteId: string; score: number; snippet: string; via: HybridHit['via'] }
  >();
  const apply = (hits: SearchHit[], source: 'bm25' | 'vector') => {
    hits.forEach((hit, rank) => {
      const current = merged.get(hit.noteId);
      const contribution = 1 / (k + rank + 1);
      if (!current) {
        merged.set(hit.noteId, {
          noteId: hit.noteId,
          score: contribution,
          snippet: hit.snippet,
          via: source
        });
        return;
      }
      current.score += contribution;
      current.via = 'both';
      if (source === 'bm25') current.snippet = hit.snippet;
    });
  };
  apply(bm25Hits, 'bm25');
  apply(vectorHits, 'vector');
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || a.noteId.localeCompare(b.noteId))
    .slice(0, limit);
}

export interface Coverage {
  indexed: number;
  total: number;
}

export interface VectorSearchResult {
  hits: SearchHit[];
  indexed: number;
}

export async function searchVector(
  query: string,
  options: {
    provider: AiProvider;
    model: string;
    database?: PkeDatabase;
    limit?: number;
    signal?: AbortSignal;
  }
): Promise<VectorSearchResult> {
  const database = options.database ?? db;
  const rows = await embeddingsForModel(options.model, database);
  if (rows.length === 0) return { hits: [], indexed: 0 };
  // 错误向上抛，由 hybridSearch 转成可展示的 reason（401/维度不一致等）。
  const [vector] = await options.provider.embed([query], options.signal);
  if (!vector || vector.length === 0) throw new Error('嵌入服务返回空向量');
  const dimension = rows[0]?.dimension ?? rows[0]?.chunks[0]?.vector.length ?? 0;
  if (dimension > 0 && vector.length !== dimension) {
    throw new Error(`索引维度（${dimension}）与当前模型（${vector.length}）不一致，请重建向量索引`);
  }
  return { hits: rankByVector(rows, vector, options.limit ?? 20), indexed: rows.length };
}

export interface HybridSearchResult {
  hits: HybridHit[];
  vectorUsed: boolean;
  reason?: string;
  coverage?: Coverage;
}

/**
 * REQ-301：AI 未启用 / 向量关闭 / 索引为空 / provider 失败 / 维度不一致时都回退 BM25。
 */
export async function hybridSearch(
  query: string,
  index: Bm25Index,
  settings: AiSettings,
  provider: AiProvider,
  database: PkeDatabase = db,
  signal?: AbortSignal
): Promise<HybridSearchResult> {
  const bm25Hits = searchBm25(index, query);
  const bm25AsHybrid: HybridHit[] = bm25Hits.map((hit) => ({ ...hit, via: 'bm25' }));
  if (!settings.enabled) {
    return { hits: bm25AsHybrid, vectorUsed: false, reason: 'AI 功能未启用' };
  }
  if (!settings.vectorSearchEnabled) {
    return { hits: bm25AsHybrid, vectorUsed: false, reason: '向量检索已关闭' };
  }
  try {
    const { hits: vectorHits, indexed } = await searchVector(query, {
      provider,
      model: settings.embedding.model,
      database,
      signal
    });
    const coverage = { indexed, total: index.docs.size };
    if (vectorHits.length === 0) {
      return {
        hits: bm25AsHybrid,
        vectorUsed: false,
        reason: indexed === 0 ? '向量索引为空' : '没有语义命中',
        coverage
      };
    }
    return { hits: mergeHybrid(bm25Hits, vectorHits), vectorUsed: true, coverage };
  } catch (error) {
    return {
      hits: bm25AsHybrid,
      vectorUsed: false,
      reason: `向量检索不可用：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * @req REQ-301 — 本地向量索引的构建与增量维护。
 *
 * 评审后修正：
 * - AI 未启用时直接返回（不调用 provider，fail-closed）。
 * - 同一模型/模式的构建做单飞（in-flight 复用），避免快速改查询并发重复嵌入。
 * - 支持 AbortSignal，取消后不再写库。
 * - force 重建不再「先清空」：逐篇覆盖，失败时旧索引保留；全部成功后才清理其它模型的旧行。
 * - 统计包含 remaining，UI 能说明「还有多少未处理」。
 */
import type { AiProvider } from '../ai/provider';
import type { AiSettings } from '../ai/settings';
import type { Note } from '../domain/note';
import { db, type PkeDatabase } from '../storage/db';
import {
  clearEmbeddingsExceptModel,
  deleteEmbedding,
  embeddingsForModel,
  putEmbedding
} from '../storage/embeddings';
import { chunkNote } from './vector';

export interface VectorIndexStats {
  indexed: number;
  skipped: number;
  failed: number;
  chunks: number;
  /** 因失败/中断未处理的篇数。 */
  remaining: number;
  aborted: boolean;
  /** 最近一次失败的简短原因（用于面板提示，便于区分 401/模型名/网络）。 */
  lastError: string | null;
}

export interface VectorIndexOptions {
  provider: AiProvider;
  database?: PkeDatabase;
  maxNotes?: number;
  batchSize?: number;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface VectorIndexStatus {
  indexed: number;
  stale: number;
  total: number;
}

function emptyStats(): VectorIndexStats {
  return {
    indexed: 0,
    skipped: 0,
    failed: 0,
    chunks: 0,
    remaining: 0,
    aborted: false,
    lastError: null
  };
}

const flights = new Map<string, Promise<VectorIndexStats>>();

function abortError(): Error {
  return new Error('向量索引构建已取消');
}

async function runEnsure(
  notes: Note[],
  settings: AiSettings,
  options: VectorIndexOptions
): Promise<VectorIndexStats> {
  const database = options.database ?? db;
  const model = settings.embedding.model;
  const batchSize = Math.max(1, options.batchSize ?? 8);
  const stats = emptyStats();
  const signal = options.signal;

  const current = await embeddingsForModel(model, database);
  // 笔记已删除的索引行直接清掉，避免搜索结果指向不存在的笔记。
  const existingIds = new Set(notes.map((note) => note.id));
  await Promise.all(
    current
      .filter((row) => !existingIds.has(row.noteId))
      .map((row) => deleteEmbedding(row.noteId, database))
  );
  const byNote = new Map(
    current.filter((row) => existingIds.has(row.noteId)).map((row) => [row.noteId, row])
  );
  const stale = options.force
    ? notes
    : notes.filter((note) => {
        const row = byNote.get(note.id);
        return !row || row.noteUpdatedAt !== note.updatedAt || row.model !== model;
      });
  const candidates = stale.slice(0, options.maxNotes ?? 50);
  if (candidates.length === 0) return stats;

  let failures = 0;
  let processed = 0;
  for (const [index, note] of candidates.entries()) {
    if (signal?.aborted) {
      stats.aborted = true;
      break;
    }
    processed = index + 1;
    const chunks = chunkNote(`${note.title}\n${note.body}`);
    if (chunks.length === 0) {
      await deleteEmbedding(note.id, database);
      stats.skipped += 1;
      options.onProgress?.(processed, candidates.length);
      continue;
    }
    try {
      const vectors: number[][] = [];
      for (let start = 0; start < chunks.length; start += batchSize) {
        if (signal?.aborted) throw abortError();
        const batch = chunks.slice(start, start + batchSize).map((chunk) => chunk.text);
        const embedded = await options.provider.embed(batch, signal);
        vectors.push(...embedded);
      }
      if (signal?.aborted) throw abortError();
      if (vectors.length !== chunks.length) throw new Error('嵌入数量与分块不一致');
      const dimension = vectors[0]?.length ?? 0;
      if (!dimension) throw new Error('嵌入向量为空');
      if (vectors.some((vector) => vector.length !== dimension)) {
        throw new Error('嵌入向量维度不一致');
      }
      await putEmbedding(
        {
          noteId: note.id,
          model,
          dimension,
          noteUpdatedAt: note.updatedAt,
          updatedAt: new Date().toISOString(),
          chunks: chunks.map((chunk, chunkIndex) => ({
            text: chunk.text,
            offset: chunk.offset,
            vector: vectors[chunkIndex]
          }))
        },
        database
      );
      stats.indexed += 1;
      stats.chunks += chunks.length;
    } catch (error) {
      if (signal?.aborted) {
        stats.aborted = true;
        break;
      }
      stats.failed += 1;
      stats.lastError = error instanceof Error ? error.message : String(error);
      failures += 1;
      // provider 不可用时不要逐篇重试打满网络：连续失败 3 次停止本轮。
      if (failures >= 3) break;
    }
    options.onProgress?.(processed, candidates.length);
  }
  stats.remaining = Math.max(0, candidates.length - processed);
  return stats;
}

export async function ensureVectorIndex(
  notes: Note[],
  settings: AiSettings,
  options: VectorIndexOptions
): Promise<VectorIndexStats> {
  // AI 总开关关闭时不允许任何自动索引（会向 provider 发送内容）。
  if (!settings.enabled) return emptyStats();
  const key = `${settings.embedding.model}:${options.force ? 'force' : 'auto'}`;
  const existing = flights.get(key);
  if (existing) return existing;
  const run = runEnsure(notes, settings, options);
  flights.set(key, run);
  try {
    return await run;
  } finally {
    if (flights.get(key) === run) flights.delete(key);
  }
}

/** 重建：逐篇覆盖，不先清空；全部成功后才清掉其它模型留下的旧行。 */
export async function rebuildVectorIndex(
  notes: Note[],
  settings: AiSettings,
  options: VectorIndexOptions
): Promise<VectorIndexStats> {
  const stats = await ensureVectorIndex(notes, settings, { ...options, force: true });
  if (!stats.aborted && stats.failed === 0) {
    await clearEmbeddingsExceptModel(settings.embedding.model, options.database ?? db);
  }
  return stats;
}

/** 面板展示用：已索引 / 过期 / 总数。 */
export async function getVectorIndexStatus(
  notes: Note[],
  settings: AiSettings,
  database: PkeDatabase = db
): Promise<VectorIndexStatus> {
  const rows = await embeddingsForModel(settings.embedding.model, database);
  const byNote = new Map(rows.map((row) => [row.noteId, row]));
  let stale = 0;
  for (const note of notes) {
    const row = byNote.get(note.id);
    if (!row || row.noteUpdatedAt !== note.updatedAt) stale += 1;
  }
  return { indexed: notes.length - stale, stale, total: notes.length };
}

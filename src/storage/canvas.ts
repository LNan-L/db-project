/**
 * @req REQ-201 — 无限画布：卡片位置与视口持久化。
 *
 * 画布卡片只是「哪篇笔记摆在画布哪个位置」，不复制笔记内容；
 * 卡片之间的连线复用 `relations`（手动关系），所以图谱视图和同步都能看到。
 */
import { db, type CanvasCard, type PkeDatabase } from './db';
import { getMetaValue, setMetaValue } from './meta';

const VIEWPORT_KEY = 'canvas_viewport';

export interface CanvasViewport {
  x: number;
  y: number;
  k: number;
}

export async function listCanvasCards(database: PkeDatabase = db): Promise<CanvasCard[]> {
  return database.canvas_cards.toArray();
}

export async function saveCanvasCard(
  noteId: string,
  x: number,
  y: number,
  database: PkeDatabase = db
): Promise<CanvasCard> {
  const existing = await database.canvas_cards.get(noteId);
  const now = new Date().toISOString();
  const card: CanvasCard = {
    noteId,
    x: Math.round(x),
    y: Math.round(y),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await database.canvas_cards.put(card);
  return card;
}

export async function removeCanvasCard(
  noteId: string,
  database: PkeDatabase = db
): Promise<void> {
  await database.canvas_cards.delete(noteId);
}

/** 笔记被删除后，画布上对应的卡片也要清掉（避免重新进入时出现空卡片）。 */
export async function pruneCanvasCards(
  existingNoteIds: Set<string>,
  database: PkeDatabase = db
): Promise<number> {
  const cards = await database.canvas_cards.toArray();
  const stale = cards.filter((card) => !existingNoteIds.has(card.noteId)).map((card) => card.noteId);
  if (stale.length > 0) await database.canvas_cards.bulkDelete(stale);
  return stale.length;
}

export async function loadCanvasViewport(
  database: PkeDatabase = db
): Promise<CanvasViewport | null> {
  const raw = await getMetaValue(VIEWPORT_KEY, database);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CanvasViewport>;
    if (
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.k !== 'number' ||
      !Number.isFinite(parsed.x) ||
      !Number.isFinite(parsed.y) ||
      !Number.isFinite(parsed.k) ||
      parsed.k <= 0
    ) {
      return null;
    }
    return { x: parsed.x, y: parsed.y, k: parsed.k };
  } catch {
    return null;
  }
}

export async function saveCanvasViewport(
  viewport: CanvasViewport,
  database: PkeDatabase = db
): Promise<void> {
  await setMetaValue(VIEWPORT_KEY, JSON.stringify(viewport), database);
}

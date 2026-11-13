/**
 * @req REQ-201 — 无限画布：添加/移动卡片、建立连线，重新进入后布局保持。
 *
 * 坐标系统：卡片位置是世界坐标（不随缩放变化），视口用 translate + scale 表达。
 * 卡片只是笔记的视图，不复制正文；卡片之间的连线直接落成 `relations`（手动关系），
 * 因此图谱视图能看到同一批连线，也会随同步到其他设备。
 * 卡片布局本身是设备本地数据（不同屏幕摆放不同），不参与同步。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { Note } from '../domain/note';
import type { ManualRelation } from '../storage/db';
import { db } from '../storage/db';
import {
  listCanvasCards,
  loadCanvasViewport,
  pruneCanvasCards,
  removeCanvasCard,
  saveCanvasCard,
  saveCanvasViewport
} from '../storage/canvas';
import type { CanvasCard } from '../storage/db';

interface CanvasViewProps {
  notes: Note[];
  manualRelations: ManualRelation[];
  onOpenNote: (noteId: string) => void;
  onAddManualRelation: (sourceId: string, targetId: string) => Promise<void>;
  onRemoveManualRelation: (id: string) => Promise<void>;
}

const CARD_W = 240;
const CARD_H = 120;
const WORLD = 20000;
const OFFSET = WORLD / 2;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;

interface Viewport {
  x: number;
  y: number;
  k: number;
}

interface CardDrag {
  noteId: string;
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 90) || '（空笔记）';
}

export function CanvasView({
  notes,
  manualRelations,
  onOpenNote,
  onAddManualRelation,
  onRemoveManualRelation
}: CanvasViewProps) {
  const [cards, setCards] = useState<CanvasCard[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, k: 1 });
  const [ready, setReady] = useState(false);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [addTarget, setAddTarget] = useState('');
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState<{ from: string; x: number; y: number } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const cardDrag = useRef<CardDrag | null>(null);
  const panDrag = useRef<{
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const connection = useRef<{ from: string } | null>(null);
  const viewportSaveTimer = useRef<number | null>(null);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.noteId, card])), [cards]);
  const candidates = useMemo(
    () => notes.filter((note) => !cardsById.has(note.id)),
    [notes, cardsById]
  );

  // 首次进入：读卡片与视口；同时清掉笔记已删除的残留卡片。
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      const [stored, savedViewport] = await Promise.all([listCanvasCards(db), loadCanvasViewport(db)]);
      setCards(stored);
      if (savedViewport) {
        setViewport({
          x: savedViewport.x,
          y: savedViewport.y,
          k: clamp(savedViewport.k, MIN_ZOOM, MAX_ZOOM)
        });
      }
      setReady(true);
    })().catch((error: unknown) => setMessage(`读取画布失败：${String(error)}`));
    // 只在首次挂载执行；notes 由下面的清理 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 笔记在其他地方被删除时，画布上同步移除卡片（并清库）。
  useEffect(() => {
    // 笔记列表还没加载完时不要清理，否则会把整张画布误删。
    if (!ready || notes.length === 0) return;
    const existing = new Set(notes.map((note) => note.id));
    setCards((current) => current.filter((card) => existing.has(card.noteId)));
    void pruneCanvasCards(existing, db);
  }, [notes, ready]);

  const scheduleViewportSave = useCallback((next: Viewport) => {
    if (viewportSaveTimer.current !== null) window.clearTimeout(viewportSaveTimer.current);
    viewportSaveTimer.current = window.setTimeout(() => {
      void saveCanvasViewport(next, db);
    }, 400);
  }, []);

  useEffect(
    () => () => {
      if (viewportSaveTimer.current !== null) window.clearTimeout(viewportSaveTimer.current);
    },
    []
  );

  const worldPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    const view = viewportRef.current;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - view.x) / view.k,
      y: (clientY - rect.top - view.y) / view.k
    };
  };

  const addCard = async () => {
    const note = candidates.find((item) => item.id === addTarget) ?? candidates[0];
    if (!note) {
      setMessage('没有可添加的笔记');
      return;
    }
    const rect = stageRef.current?.getBoundingClientRect();
    const view = viewportRef.current;
    const centerX = rect ? (rect.width / 2 - view.x) / view.k : 120;
    const centerY = rect ? (rect.height / 2 - view.y) / view.k : 120;
    // 网格排布：新卡片依次摆在视口中心左侧，避免互相盖住（盖住后拖拽/连线会点错卡片）。
    const column = cards.length % 3;
    const row = Math.floor(cards.length / 3);
    const card = await saveCanvasCard(
      note.id,
      centerX - CARD_W * 1.5 + column * (CARD_W + 24),
      centerY - CARD_H / 2 + row * (CARD_H + 24),
      db
    );
    setCards((current) => [...current.filter((item) => item.noteId !== card.noteId), card]);
    setAddTarget('');
    setMessage(`已添加「${note.title || '未命名笔记'}」`);
  };

  const removeSelectedCard = async () => {
    if (!selectedCard) return;
    const noteId = selectedCard;
    await removeCanvasCard(noteId, db);
    setCards((current) => current.filter((card) => card.noteId !== noteId));
    setSelectedCard(null);
    setMessage('已从画布移除卡片（笔记本身未删除）');
  };

  const removeSelectedEdge = async () => {
    if (!selectedEdge) return;
    await onRemoveManualRelation(selectedEdge);
    setSelectedEdge(null);
    setMessage('已删除连线');
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('.canvas-card, .canvas-toolbar, .canvas-edge-hit, .canvas-zoom')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panDrag.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: viewport.x,
      originY: viewport.y
    };
    setSelectedCard(null);
    setSelectedEdge(null);
  };

  const onStagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panDrag.current;
    if (!pan) return;
    setViewport((current) => ({
      ...current,
      x: pan.originX + (event.clientX - pan.startClientX),
      y: pan.originY + (event.clientY - pan.startClientY)
    }));
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!panDrag.current) return;
    panDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scheduleViewportSave(viewportRef.current);
  };

  // 滚轮缩放要用非 passive 监听（React 的 onWheel 无法 preventDefault）。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const current = viewportRef.current;
      const nextK = clamp(current.k * (event.deltaY < 0 ? 1.1 : 0.9), MIN_ZOOM, MAX_ZOOM);
      if (nextK === current.k) return;
      const ratio = nextK / current.k;
      const next = {
        k: nextK,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio
      };
      setViewport(next);
      scheduleViewportSave(next);
    };
    stage.addEventListener('wheel', handler, { passive: false });
    return () => stage.removeEventListener('wheel', handler);
  }, [scheduleViewportSave]);

  const onCardPointerDown = (event: ReactPointerEvent<HTMLDivElement>, card: CanvasCard) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedCard(card.noteId);
    setSelectedEdge(null);
    cardDrag.current = {
      noteId: card.noteId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: card.x,
      originY: card.y,
      x: card.x,
      y: card.y
    };
  };

  const onCardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = cardDrag.current;
    if (!drag) return;
    const k = viewportRef.current.k;
    drag.x = drag.originX + (event.clientX - drag.startClientX) / k;
    drag.y = drag.originY + (event.clientY - drag.startClientY) / k;
    const { noteId, x, y } = drag;
    setCards((current) => current.map((card) => (card.noteId === noteId ? { ...card, x, y } : card)));
  };

  const onCardPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = cardDrag.current;
    if (!drag) return;
    cardDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const moved = Math.abs(drag.x - drag.originX) + Math.abs(drag.y - drag.originY) > 1;
    if (!moved) return;
    const x = Math.round(drag.x);
    const y = Math.round(drag.y);
    setCards((current) =>
      current.map((card) => (card.noteId === drag.noteId ? { ...card, x, y } : card))
    );
    void saveCanvasCard(drag.noteId, x, y, db);
  };

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, card: CanvasCard) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedCard(card.noteId);
    setSelectedEdge(null);
    connection.current = { from: card.noteId };
    setDraft({ from: card.noteId, x: card.x + CARD_W / 2, y: card.y + CARD_H / 2 });
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!connection.current) return;
    const point = worldPoint(event.clientX, event.clientY);
    setDraft({ from: connection.current.from, x: point.x, y: point.y });
  };

  const onHandlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const from = connection.current?.from;
    connection.current = null;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!from) return;
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const target = element?.closest<HTMLElement>('[data-canvas-note-id]');
    const targetId = target?.dataset.canvasNoteId;
    if (!targetId) {
      setMessage('连线要落在另一张卡片上');
      return;
    }
    if (targetId === from) {
      setMessage('不能连到自己');
      return;
    }
    const exists = manualRelations.some(
      (relation) =>
        (relation.sourceId === from && relation.targetId === targetId) ||
        (relation.sourceId === targetId && relation.targetId === from)
    );
    if (exists) {
      setMessage('两张卡片之间已经有连线');
      return;
    }
    void onAddManualRelation(from, targetId).then(() => setMessage('已建立连线'));
  };

  const edges = useMemo(
    () =>
      manualRelations.filter(
        (relation) => cardsById.has(relation.sourceId) && cardsById.has(relation.targetId)
      ),
    [manualRelations, cardsById]
  );

  const zoomBy = (factor: number) => {
    const current = viewportRef.current;
    const rect = stageRef.current?.getBoundingClientRect();
    const nextK = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
    const px = rect ? rect.width / 2 : 0;
    const py = rect ? rect.height / 2 : 0;
    const ratio = nextK / current.k;
    const next = {
      k: nextK,
      x: px - (px - current.x) * ratio,
      y: py - (py - current.y) * ratio
    };
    setViewport(next);
    scheduleViewportSave(next);
  };

  const resetViewport = () => {
    const next = { x: 40, y: 40, k: 1 };
    setViewport(next);
    scheduleViewportSave(next);
  };

  return (
    <div className="canvas-view" data-testid="canvas-view">
      <div className="canvas-toolbar" data-testid="canvas-toolbar">
        <select
          data-testid="canvas-note-select"
          value={addTarget}
          onChange={(event) => setAddTarget(event.target.value)}
          aria-label="选择要添加到画布的笔记"
          disabled={candidates.length === 0}
        >
          <option value="">
            {candidates.length > 0 ? '选择要添加的笔记' : '所有笔记都已在画布上'}
          </option>
          {candidates.map((note) => (
            <option key={note.id} value={note.id}>
              {note.title || '未命名笔记'}
            </option>
          ))}
        </select>
        <button type="button" data-testid="canvas-add-card" onClick={() => void addCard()} disabled={candidates.length === 0}>
          添加卡片
        </button>
        <button
          type="button"
          data-testid="canvas-remove-card"
          onClick={() => void removeSelectedCard()}
          disabled={!selectedCard}
          title="只从画布移除，不删除笔记"
        >
          移除选中卡片
        </button>
        <button
          type="button"
          data-testid="canvas-remove-edge"
          onClick={() => void removeSelectedEdge()}
          disabled={!selectedEdge}
        >
          删除选中连线
        </button>
        <span className="canvas-zoom">
          <button type="button" data-testid="canvas-zoom-out" onClick={() => zoomBy(0.9)}>
            −
          </button>
          <span data-testid="canvas-zoom">{Math.round(viewport.k * 100)}%</span>
          <button type="button" data-testid="canvas-zoom-in" onClick={() => zoomBy(1.1)}>
            +
          </button>
          <button type="button" data-testid="canvas-zoom-reset" onClick={resetViewport}>
            重置
          </button>
        </span>
        <span className="canvas-hint">拖动空白处平移，滚轮缩放；拖卡片移动，拖右侧圆点连线；双击卡片打开笔记</span>
        {message && (
          <span className="canvas-message" data-testid="canvas-message">
            {message}
          </span>
        )}
      </div>

      <div
        className="canvas-stage"
        data-testid="canvas-stage"
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        onPointerMove={onStagePointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className="canvas-world"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})` }}
        >
          <svg
            className="canvas-edges"
            width={WORLD}
            height={WORLD}
            style={{ left: -OFFSET, top: -OFFSET }}
            aria-hidden="true"
          >
            {edges.map((relation) => {
              const source = cardsById.get(relation.sourceId) as CanvasCard;
              const target = cardsById.get(relation.targetId) as CanvasCard;
              const x1 = source.x + CARD_W / 2 + OFFSET;
              const y1 = source.y + CARD_H / 2 + OFFSET;
              const x2 = target.x + CARD_W / 2 + OFFSET;
              const y2 = target.y + CARD_H / 2 + OFFSET;
              return (
                <g key={relation.id}>
                  <line
                    className="canvas-edge-hit"
                    data-testid="canvas-edge-hit"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelectedEdge(relation.id);
                      setSelectedCard(null);
                    }}
                  />
                  <line
                    className={`canvas-edge${selectedEdge === relation.id ? ' active' : ''}`}
                    data-testid="canvas-edge"
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                  />
                </g>
              );
            })}
            {draft && (
              <line
                className="canvas-edge-draft"
                data-testid="canvas-edge-draft"
                x1={((cardsById.get(draft.from)?.x ?? 0) + CARD_W / 2 + OFFSET)}
                y1={((cardsById.get(draft.from)?.y ?? 0) + CARD_H / 2 + OFFSET)}
                x2={draft.x + OFFSET}
                y2={draft.y + OFFSET}
              />
            )}
          </svg>

          {cards.map((card) => {
            const note = noteById.get(card.noteId);
            if (!note) return null;
            return (
              <div
                key={card.noteId}
                className={`canvas-card${selectedCard === card.noteId ? ' active' : ''}`}
                data-testid="canvas-card"
                data-canvas-note-id={card.noteId}
                data-card-x={Math.round(card.x)}
                data-card-y={Math.round(card.y)}
                style={{ transform: `translate(${card.x}px, ${card.y}px)` }}
                onPointerDown={(event) => onCardPointerDown(event, card)}
                onPointerMove={onCardPointerMove}
                onPointerUp={onCardPointerUp}
                onPointerCancel={onCardPointerUp}
                onDoubleClick={() => onOpenNote(card.noteId)}
              >
                <strong className="canvas-card-title">{note.title || '未命名笔记'}</strong>
                <span className="canvas-card-body">{snippet(note.body)}</span>
                <span className="canvas-card-meta">{note.folder || '未分类'}</span>
                <button
                  type="button"
                  className="canvas-card-handle"
                  data-testid="canvas-handle"
                  aria-label="从这里拖出连线"
                  onPointerDown={(event) => onHandlePointerDown(event, card)}
                  onPointerMove={onHandlePointerMove}
                  onPointerUp={onHandlePointerUp}
                  onPointerCancel={() => {
                    connection.current = null;
                    setDraft(null);
                  }}
                />
              </div>
            );
          })}
        </div>

        {ready && cards.length === 0 && (
          <div className="canvas-empty" data-testid="canvas-empty">
            <h1>无限画布</h1>
            <p>从上方选择一篇笔记「添加卡片」，然后拖动摆放、拖圆点连线。</p>
          </div>
        )}
      </div>
    </div>
  );
}

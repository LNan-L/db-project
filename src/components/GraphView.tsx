/**
 * @req REQ-105 — 图谱缩放、平移、拖动、选择。
 * @req REQ-203 — 1/2/3 层局部图谱。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../domain/note';
import type { LinkIndex } from '../domain/wikiLinks';
import type { ManualRelation } from '../storage/db';
import {
  LAYOUT_FORCE_LIMIT,
  buildGraph,
  layoutGraph,
  nodesWithinDepth,
  type GraphPositions
} from '../graph/graph';

interface GraphViewProps {
  notes: Note[];
  linkIndex: LinkIndex;
  manualRelations: ManualRelation[];
  onOpenNote: (noteId: string) => void;
  onAddManualRelation: (sourceId: string, targetId: string) => Promise<void>;
  onRemoveManualRelation: (id: string) => Promise<void>;
}

type Depth = 'all' | 1 | 2 | 3;

const WIDTH = 900;
const HEIGHT = 580;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function GraphView({
  notes,
  linkIndex,
  manualRelations,
  onOpenNote,
  onAddManualRelation,
  onRemoveManualRelation
}: GraphViewProps) {
  const graph = useMemo(
    () => buildGraph(notes, linkIndex, manualRelations),
    [notes, linkIndex, manualRelations]
  );
  const initialPositions = useMemo(
    () => layoutGraph(graph.nodes, graph.edges),
    [graph]
  );
  const [positions, setPositions] = useState<GraphPositions>(initialPositions);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [depth, setDepth] = useState<Depth>('all');
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [relationTarget, setRelationTarget] = useState('');
  const [aiPreview, setAiPreview] = useState<{ sourceId: string; targetId: string } | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
  const svgRef = useRef<SVGSVGElement>(null);
  const nodeDrag = useRef<{
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const panDrag = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    setPositions(initialPositions);
  }, [initialPositions]);

  useEffect(() => {
    setAiPreview(null);
  }, [selectedId, relationTarget]);

  const selected = selectedId ? graph.byId.get(selectedId) ?? null : null;
  const visibleIds = useMemo(() => {
    if (!selectedId || depth === 'all') return null;
    return nodesWithinDepth(graph, selectedId, depth);
  }, [graph, selectedId, depth]);
  const visibleNodes = visibleIds
    ? graph.nodes.filter((node) => visibleIds.has(node.id))
    : graph.nodes;
  const visibleEdges = visibleIds
    ? graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    : graph.edges;
  const relationOptions = selectedId
    ? graph.nodes.filter((node) => node.id !== selectedId)
    : [];

  const centerOn = (id: string) => {
    const p = positions[id];
    if (!p) return;
    setTransform((current) => ({
      ...current,
      x: WIDTH / 2 - p.x * current.k,
      y: HEIGHT / 2 - p.y * current.k
    }));
  };

  const openSelected = () => {
    if (selectedId) onOpenNote(selectedId);
  };

  const runSearch = () => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
      setMessage('输入笔记标题');
      return;
    }
    const hit = graph.nodes.find((node) => node.title.toLocaleLowerCase().includes(needle));
    if (!hit) {
      setMessage('没有匹配节点');
      return;
    }
    setSelectedId(hit.id);
    centerOn(hit.id);
    setMessage(`已定位：${hit.title}`);
  };

  return (
    <div className="graph-view" data-testid="graph-view">
      <div className="graph-toolbar">
        <div className="graph-search">
          <input
            data-testid="graph-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') runSearch();
            }}
            placeholder="搜索节点标题"
            aria-label="搜索图谱节点"
          />
          <button type="button" data-testid="graph-search-go" onClick={runSearch}>
            定位
          </button>
        </div>

        <div className="graph-depths" data-testid="graph-depth">
          <button type="button" data-testid="graph-depth-all" className={depth === 'all' ? 'active' : ''} onClick={() => setDepth('all')}>
            全部
          </button>
          {[1, 2, 3].map((value) => (
            <button
              type="button"
              key={value}
              data-testid={`graph-depth-${value}`}
              className={depth === value ? 'active' : ''}
              aria-pressed={depth === value}
              onClick={() => {
                setDepth(value as Depth);
                if (!selectedId && graph.nodes[0]) setSelectedId(graph.nodes[0].id);
              }}
            >
              {value} 层
            </button>
          ))}
        </div>

        <div className="graph-zoom">
          <button
            type="button"
            data-testid="graph-zoom-out"
            aria-label="缩小图谱"
            title="缩小"
            onClick={() => setTransform((t) => ({ ...t, k: clamp(t.k - 0.1, MIN_ZOOM, MAX_ZOOM) }))}
          >
            −
          </button>
          <span data-testid="graph-zoom" aria-live="polite">
            {Math.round(transform.k * 100)}%
          </span>
          <button
            type="button"
            data-testid="graph-zoom-in"
            aria-label="放大图谱"
            title="放大"
            onClick={() => setTransform((t) => ({ ...t, k: clamp(t.k + 0.1, MIN_ZOOM, MAX_ZOOM) }))}
          >
            +
          </button>
          <button type="button" data-testid="graph-reset" onClick={() => setTransform({ x: 0, y: 0, k: 1 })}>
            重置
          </button>
        </div>
      </div>

      <div className="graph-status">
        <span data-testid="graph-selected-label">
          {selected ? selected.title : '未选择节点'}
        </span>
        <button type="button" data-testid="open-graph-node" onClick={openSelected} disabled={!selectedId}>
          打开笔记
        </button>
        <span className="graph-hint">拖动节点/画布；滚轮缩放；双击节点打开</span>
        {graph.nodes.length > LAYOUT_FORCE_LIMIT && (
          <span className="graph-hint" data-testid="graph-large-hint">
            图谱较大（{graph.nodes.length} 个节点）：布局精度已自动降低，可用「层」筛选聚焦
          </span>
        )}
        <span className="graph-ai-legend" data-testid="graph-ai-legend">
          <i className="legend-swatch ai" /> AI 待审核建议（Phase 5 占位）
        </span>
        {message && (
          <span data-testid="graph-message" role="status" aria-live="polite">
            {message}
          </span>
        )}
      </div>

      <div className="graph-relations">
        <span>手动关系：</span>
        <select
          data-testid="graph-relation-target"
          value={relationTarget}
          onChange={(event) => setRelationTarget(event.target.value)}
          disabled={!selectedId || relationOptions.length === 0}
        >
          <option value="">选择目标节点</option>
          {relationOptions.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="graph-add-relation"
          disabled={!selectedId || !relationTarget}
          onClick={() => {
            if (!selectedId || !relationTarget) return;
            setAiPreview(null);
            void onAddManualRelation(selectedId, relationTarget).then(() => {
              setMessage('已添加手动关系');
              setRelationTarget('');
            });
          }}
        >
          添加关系
        </button>
        <button
          type="button"
          data-testid="graph-ai-preview"
          disabled={!selectedId || !relationTarget}
          onClick={() => {
            if (aiPreview) {
              setAiPreview(null);
              setMessage('');
              return;
            }
            if (!selectedId || !relationTarget) return;
            setAiPreview({ sourceId: selectedId, targetId: relationTarget });
            setMessage('AI 建议仅为样式占位，不是 AI 生成；真实建议在 Phase 5。');
          }}
        >
          {aiPreview ? '隐藏 AI 建议样式' : '预览 AI 建议样式'}
        </button>
        {manualRelations
          .filter((relation) => relation.sourceId === selectedId || relation.targetId === selectedId)
          .map((relation) => {
            const otherId = relation.sourceId === selectedId ? relation.targetId : relation.sourceId;
            const other = graph.byId.get(otherId);
            return (
              <span className="manual-relation-chip" key={relation.id}>
                {other?.title ?? '未知'}
                <button
                  type="button"
                  data-testid="graph-remove-relation"
                  aria-label={`删除与 ${other?.title ?? '未知'} 的手动关系`}
                  onClick={() => void onRemoveManualRelation(relation.id)}
                >
                  ×
                </button>
              </span>
            );
          })}
      </div>

      {graph.nodes.length === 0 ? (
        <div className="graph-empty" data-testid="graph-empty">
          还没有笔记，先创建笔记和双链。
        </div>
      ) : (
        <svg
          ref={svgRef}
          className="graph-canvas"
          data-testid="graph-canvas"
          role="img"
          aria-label={`知识图谱，共 ${graph.nodes.length} 个节点、${graph.edges.length} 条连线`}
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget) return;
            panDrag.current = {
              startX: event.clientX,
              startY: event.clientY,
              originX: transform.x,
              originY: transform.y
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!panDrag.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const dx = ((event.clientX - panDrag.current.startX) / rect.width) * WIDTH;
            const dy = ((event.clientY - panDrag.current.startY) / rect.height) * HEIGHT;
            setTransform((current) => ({
              ...current,
              x: panDrag.current!.originX + dx,
              y: panDrag.current!.originY + dy
            }));
          }}
          onPointerUp={() => {
            panDrag.current = null;
          }}
          onWheel={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
            const py = ((event.clientY - rect.top) / rect.height) * HEIGHT;
            setTransform((current) => {
              const nextK = clamp(current.k * (event.deltaY < 0 ? 1.1 : 0.9), MIN_ZOOM, MAX_ZOOM);
              return {
                k: nextK,
                x: px - ((px - current.x) / current.k) * nextK,
                y: py - ((py - current.y) / current.k) * nextK
              };
            });
          }}
        >
          <rect width={WIDTH} height={HEIGHT} fill="transparent" pointerEvents="none" />
          <g data-testid="graph-viewport" transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
            {visibleEdges.map((edge) => {
              const a = positions[edge.source];
              const b = positions[edge.target];
              if (!a || !b) return null;
              return (
                <line
                  key={edge.id}
                  data-testid="graph-edge"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className={`graph-edge ${edge.kind}`}
                  data-kind={edge.kind}
                />
              );
            })}

            {aiPreview &&
              positions[aiPreview.sourceId] &&
              positions[aiPreview.targetId] &&
              (!visibleIds ||
                (visibleIds.has(aiPreview.sourceId) && visibleIds.has(aiPreview.targetId))) && (
                <line
                  data-testid="graph-edge-ai"
                  data-kind="ai-suggestion"
                  className="graph-edge ai-suggestion"
                  x1={positions[aiPreview.sourceId]!.x}
                  y1={positions[aiPreview.sourceId]!.y}
                  x2={positions[aiPreview.targetId]!.x}
                  y2={positions[aiPreview.targetId]!.y}
                />
              )}

            {visibleNodes.map((node) => {
              const p = positions[node.id];
              if (!p) return null;
              return (
                <g
                  key={node.id}
                  data-testid="graph-node"
                  data-note-id={node.id}
                  className={`graph-node${node.id === selectedId ? ' selected' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`节点：${node.title}`}
                  aria-pressed={node.id === selectedId}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelectedId(node.id);
                    }
                  }}
                  transform={`translate(${p.x} ${p.y})`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    nodeDrag.current = {
                      id: node.id,
                      startX: event.clientX,
                      startY: event.clientY,
                      originX: p.x,
                      originY: p.y,
                      moved: false
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => {
                    const drag = nodeDrag.current;
                    if (!drag || drag.id !== node.id) return;
                    const dx = event.clientX - drag.startX;
                    const dy = event.clientY - drag.startY;
                    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
                    if (!drag.moved) return;
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setPositions((current) => ({
                      ...current,
                      [node.id]: {
                        x: drag.originX + (dx / rect.width) * WIDTH / transform.k,
                        y: drag.originY + (dy / rect.height) * HEIGHT / transform.k
                      }
                    }));
                  }}
                  onPointerUp={(event) => {
                    const drag = nodeDrag.current;
                    nodeDrag.current = null;
                    event.stopPropagation();
                    if (drag && !drag.moved) {
                      setSelectedId(node.id);
                      setMessage('');
                    }
                  }}
                  onDoubleClick={() => onOpenNote(node.id)}
                >
                  <circle r={26} />
                  <text textAnchor="middle" dy={4}>
                    {node.title.length > 10 ? `${node.title.slice(0, 10)}…` : node.title}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      )}
    </div>
  );
}

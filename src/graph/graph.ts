/**
 * @req REQ-105 — 图谱数据模型与确定性布局。
 * @req REQ-203 — 1/2/3 层邻居。
 */
import type { Note } from '../domain/note';
import type { ManualRelation } from '../storage/db';
import { getOutgoingLinks, type LinkIndex } from '../domain/wikiLinks';

export interface GraphNode {
  id: string;
  title: string;
  folder: string;
  tags: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'explicit' | 'manual';
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
}

export function buildGraph(
  notes: Note[],
  index: LinkIndex,
  manualRelations: ManualRelation[] = []
): GraphData {
  const nodes = notes.map((note) => ({
    id: note.id,
    title: note.title || '未命名笔记',
    folder: note.folder,
    tags: note.tags
  }));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const note of notes) {
    for (const link of getOutgoingLinks(note, index)) {
      if (!link.noteId || link.noteId === note.id) continue;
      const [source, target] = [note.id, link.noteId].sort();
      const key = `explicit:${source}->${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: key, source, target, kind: 'explicit' });
    }
  }

  const noteIds = new Set(notes.map((note) => note.id));
  for (const relation of manualRelations) {
    if (!noteIds.has(relation.sourceId) || !noteIds.has(relation.targetId)) continue;
    const key = `manual:${relation.sourceId}->${relation.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: key,
      source: relation.sourceId,
      target: relation.targetId,
      kind: 'manual'
    });
  }

  return { nodes, edges, byId: new Map(nodes.map((node) => [node.id, node])) };
}

export function nodesWithinDepth(
  graph: GraphData,
  startId: string,
  depth: number
): Set<string> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const a = adjacency.get(edge.source) ?? new Set<string>();
    a.add(edge.target);
    adjacency.set(edge.source, a);
    const b = adjacency.get(edge.target) ?? new Set<string>();
    b.add(edge.source);
    adjacency.set(edge.target, b);
  }

  const visible = new Set<string>([startId]);
  let frontier = [startId];
  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (visible.has(neighbor)) continue;
        visible.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return visible;
}

export type GraphPositions = Record<string, { x: number; y: number }>;

/**
 * B-7：布局预算。斥力是 O(n²) × 迭代次数，节点一多会卡住主线程。
 * 超过 FORCE_LIMIT 逐步减少迭代；超过 SKIP_FORCE 直接保留圆周初值。
 * 都是确定性规则，E2E 布局不抖动。
 */
export const LAYOUT_FORCE_LIMIT = 120;
export const LAYOUT_SKIP_FORCE = 400;

function layoutIterations(count: number): number {
  if (count > LAYOUT_SKIP_FORCE) return 0;
  if (count > LAYOUT_FORCE_LIMIT) {
    // 120→110 次，400→约 33 次，线性收敛，避免大图长时间占用主线程。
    return Math.max(24, Math.round((110 * LAYOUT_FORCE_LIMIT) / count));
  }
  return 110;
}

export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphPositions {
  const width = 900;
  const height = 580;
  const centerX = width / 2;
  const centerY = height / 2;
  const count = Math.max(nodes.length, 1);
  const radius = Math.min(230, 110 + count * 18);
  const positions: GraphPositions = {};

  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
    positions[node.id] = {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    };
  });

  if (nodes.length <= 1) return positions;

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  // Deterministic force relaxation; no randomness so E2E/layout stays stable.
  const iterations = layoutIterations(nodes.length);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forces = new Map(nodes.map((node) => [node.id, { x: 0, y: 0 }]));
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = positions[nodes[i]!.id]!;
        const b = positions[nodes[j]!.id]!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 1) {
          dx = 1;
          dy = 1;
          distance = 1;
        }
        const repulsion = 9000 / (distance * distance);
        const fx = (dx / distance) * repulsion;
        const fy = (dy / distance) * repulsion;
        const fa = forces.get(nodes[i]!.id)!;
        const fb = forces.get(nodes[j]!.id)!;
        fa.x += fx;
        fa.y += fy;
        fb.x -= fx;
        fb.y -= fy;
      }
    }

    for (const edge of edges) {
      const a = positions[edge.source]!;
      const b = positions[edge.target]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const attraction = (distance - 150) * 0.008;
      const fx = (dx / distance) * attraction;
      const fy = (dy / distance) * attraction;
      const fa = forces.get(edge.source)!;
      const fb = forces.get(edge.target)!;
      fa.x += fx;
      fa.y += fy;
      fb.x -= fx;
      fb.y -= fy;
    }

    for (const node of nodes) {
      const p = positions[node.id]!;
      const f = forces.get(node.id)!;
      f.x += (centerX - p.x) * 0.002;
      f.y += (centerY - p.y) * 0.002;
      p.x = Math.max(50, Math.min(width - 50, p.x + f.x));
      p.y = Math.max(45, Math.min(height - 45, p.y + f.y));
    }
  }

  // Keep degree high nodes slightly inward for readability.
  for (const node of nodes) {
    const p = positions[node.id]!;
    const d = degree.get(node.id) ?? 0;
    if (d > 1) {
      p.x += (centerX - p.x) * 0.08;
      p.y += (centerY - p.y) * 0.08;
    }
  }
  return positions;
}

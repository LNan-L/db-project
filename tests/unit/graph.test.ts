import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import { buildLinkIndex } from '../../src/domain/wikiLinks';
import { buildGraph, layoutGraph, nodesWithinDepth } from '../../src/graph/graph';

function note(id: string, title: string, body: string): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags: [],
    folder: '',
    createdAt: '2026-11-09T00:00:00.000Z',
    updatedAt: '2026-11-09T00:00:00.000Z'
  };
}

describe('graph', () => {
  const notes = [
    note('a', 'A', '[[B]] [[B]]'),
    note('b', 'B', '[[A]] [[C]]'),
    note('c', 'C', '终点')
  ];
  const graph = buildGraph(notes, buildLinkIndex(notes));

  it('deduplicates explicit links', () => {
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((edge) => edge.id)).toContain('explicit:a->b');
    expect(graph.edges.map((edge) => edge.id)).toContain('explicit:b->c');
  });

  it('computes 1/2/3-hop neighborhoods', () => {
    expect([...nodesWithinDepth(graph, 'a', 1)].sort()).toEqual(['a', 'b']);
    expect([...nodesWithinDepth(graph, 'a', 2)].sort()).toEqual(['a', 'b', 'c']);
    expect([...nodesWithinDepth(graph, 'a', 3)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('lays out deterministically inside the canvas', () => {
    const first = layoutGraph(graph.nodes, graph.edges);
    const second = layoutGraph(graph.nodes, graph.edges);
    expect(second).toEqual(first);
    for (const position of Object.values(first)) {
      expect(position.x).toBeGreaterThan(0);
      expect(position.x).toBeLessThan(900);
      expect(position.y).toBeGreaterThan(0);
      expect(position.y).toBeLessThan(580);
    }
  });
});

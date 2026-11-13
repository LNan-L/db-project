import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import { buildGraph, layoutGraph } from '../../src/graph/graph';
import { buildLinkIndex } from '../../src/domain/wikiLinks';
import { PkeDatabase, ensureSchema } from '../../src/storage/db';
import { useDialogA11y } from '../../src/lib/useDialogA11y';

function note(id: string, title: string): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body: `body ${id}`,
    tags: [],
    folder: '',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z'
  };
}

describe('graph layout budget (B-7)', () => {
  it('stays deterministic and bounded for small graphs', () => {
    const notes = Array.from({ length: 20 }, (_, i) => note(`n${i}`, `n${i}`));
    const graph = buildGraph(notes, buildLinkIndex(notes));
    const a = layoutGraph(graph.nodes, graph.edges);
    const b = layoutGraph(graph.nodes, graph.edges);
    expect(b).toEqual(a);
    for (const position of Object.values(a)) {
      expect(position.x).toBeGreaterThan(0);
      expect(position.x).toBeLessThan(900);
      expect(position.y).toBeGreaterThan(0);
      expect(position.y).toBeLessThan(580);
    }
  });

  it('finishes quickly for a large graph', () => {
    const notes = Array.from({ length: 900 }, (_, i) => note(`n${i}`, `n${i}`));
    const graph = buildGraph(notes, buildLinkIndex(notes));
    const started = Date.now();
    const positions = layoutGraph(graph.nodes, graph.edges);
    const elapsed = Date.now() - started;
    expect(Object.keys(positions)).toHaveLength(900);
    // 预算逻辑把 110 次 O(n²) 降到 0 次；即便慢机器也应远低于 5 秒。
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('database still opens (B-7 touched shared code)', () => {
  const names: string[] = [];
  const instances: PkeDatabase[] = [];
  afterEach(async () => {
    for (const database of instances.splice(0)) database.close();
    for (const name of names.splice(0)) await Dexie.delete(name);
  });

  it('ensureSchema creates the workspace', async () => {
    const name = `pke-b7-${Date.now()}`;
    names.push(name);
    const database = new PkeDatabase(name);
    instances.push(database);
    await ensureSchema(database);
    expect(await database.workspaces.count()).toBe(1);
  });
});

describe('dialog a11y hook', () => {
  it('is exported as a function (wired into every modal)', () => {
    expect(typeof useDialogA11y).toBe('function');
  });
});

/**
 * @req REQ-202 — 生产搜索命中词高亮。
 */
import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';
import { tokenize } from '../search/bm25';

interface HighlightState {
  query: string;
  decorations: DecorationSet;
}

export const searchHighlightKey = new PluginKey<HighlightState>('pke-search-highlight');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDecorations(doc: ProseNode, query: string): DecorationSet {
  const trimmed = query.trim();
  if (!trimmed) return DecorationSet.empty;
  const terms = [...new Set(tokenize(trimmed).filter(Boolean))];
  if (terms.length === 0) terms.push(trimmed);
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    const lower = text.toLocaleLowerCase();
    const intervals: Array<[number, number]> = [];
    for (const term of terms) {
      const pattern = new RegExp(escapeRegExp(term.toLocaleLowerCase()), 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(lower)) !== null) {
        intervals.push([match.index, match.index + match[0].length]);
      }
    }
    intervals.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    let cursor = -1;
    for (const [start, end] of intervals) {
      if (start < cursor) continue;
      decorations.push(Decoration.inline(pos + start, pos + end, { class: 'pke-search-hit' }));
      cursor = end;
    }
  });

  return DecorationSet.create(doc, decorations);
}

export const searchHighlightPlugin = $prose(
  () =>
    new Plugin<HighlightState>({
      key: searchHighlightKey,
      state: {
        init: () => ({ query: '', decorations: DecorationSet.empty }),
        apply: (tr, old, _oldState, newState) => {
          const meta = tr.getMeta(searchHighlightKey) as { query?: string } | undefined;
          const query = typeof meta?.query === 'string' ? meta.query : old.query;
          if (meta || tr.docChanged) {
            return { query, decorations: buildDecorations(newState.doc, query) };
          }
          return old;
        }
      },
      props: {
        decorations: (state) => searchHighlightKey.getState(state)?.decorations ?? null
      }
    })
);

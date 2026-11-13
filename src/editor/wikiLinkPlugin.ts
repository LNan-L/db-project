/**
 * @req REQ-103 — 生产编辑器内双链装饰：只显示标题，点击由外层处理。
 */
import { $prose } from '@milkdown/kit/utils';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

const wikiLinkKey = new PluginKey('pke-wiki-link');
const WIKI_LINK = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;

function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const pattern = new RegExp(WIKI_LINK.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(node.text)) !== null) {
      const target = (match[1] ?? '').trim();
      const label = (match[2] ?? match[1] ?? '').trim();
      if (!target) continue;
      const from = pos + match.index;
      const to = from + match[0].length;
      decorations.push(
        Decoration.inline(from, to, {
          class: 'pke-wikilink',
          'data-wikilink-target': target,
          'data-wikilink-label': label || target
        })
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const wikiLinkPlugin = $prose(
  () =>
    new Plugin({
      key: wikiLinkKey,
      state: {
        init: (_config, state) => buildDecorations(state.doc),
        apply: (tr, old) =>
          tr.docChanged ? buildDecorations(tr.doc) : old.map(tr.mapping, tr.doc)
      },
      props: {
        decorations: (state) => wikiLinkKey.getState(state) ?? null
      }
    })
);

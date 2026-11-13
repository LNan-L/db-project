/**
 * @req REQ-102 — 生产 Markdown 编辑器；Phase 1 第一版。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';
import { wikiLinkPlugin } from '../editor/wikiLinkPlugin';
import {
  searchHighlightKey,
  searchHighlightPlugin
} from '../editor/searchHighlightPlugin';

interface MarkdownEditorProps {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
  onOpenLink?: (target: string) => void;
  highlightQuery?: string;
}

export interface MarkdownEditorHandle {
  getMarkdown: () => string;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor({ initialMarkdown, onChange, onOpenLink, highlightQuery = '' }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const crepeRef = useRef<Crepe | null>(null);
    const onChangeRef = useRef(onChange);
    const onOpenLinkRef = useRef(onOpenLink);
    const highlightRef = useRef(highlightQuery);
    const initialRef = useRef(initialMarkdown);
    onChangeRef.current = onChange;
    onOpenLinkRef.current = onOpenLink;
    highlightRef.current = highlightQuery;

    const applyHighlight = (query: string) => {
      const crepe = crepeRef.current;
      if (!crepe) return;
      try {
        crepe.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          view.dispatch(view.state.tr.setMeta(searchHighlightKey, { query }));
        });
      } catch {
        // editor not ready
      }
    };

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown: () => crepeRef.current?.getMarkdown() ?? initialRef.current
      }),
      []
    );

    useEffect(() => {
      const root = rootRef.current;
      if (!root) return;

      let disposed = false;
      let created = false;

      const crepe = new Crepe({
        root,
        defaultValue: initialRef.current,
        features: {
          [Crepe.Feature.Latex]: false,
          [Crepe.Feature.CodeMirror]: false,
          [Crepe.Feature.ImageBlock]: false
        }
      });
      crepeRef.current = crepe;

      crepe.addFeature((editor) => {
        editor.use(wikiLinkPlugin);
        editor.use(searchHighlightPlugin);
      });

      const handleClick = (event: MouseEvent) => {
        const element = (event.target as HTMLElement | null)?.closest('.pke-wikilink');
        if (!(element instanceof HTMLElement)) return;
        const target = element.dataset.wikilinkTarget;
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenLinkRef.current?.(target);
      };
      root.addEventListener('click', handleClick);

      crepe.on((listener) => {
        listener.markdownUpdated((_ctx, markdown) => {
          onChangeRef.current(markdown);
        });
      });

      void crepe
        .create()
        .then(() => {
          created = true;
          if (disposed) {
            return crepe.destroy().then(() => undefined);
          }
          applyHighlight(highlightRef.current);
          return undefined;
        })
        .catch((error: unknown) => {
          console.error('Milkdown create failed', error);
        });

      return () => {
        disposed = true;
        root.removeEventListener('click', handleClick);
        root.replaceChildren();
        if (created) {
          void crepe.destroy().catch(() => undefined);
        }
        if (crepeRef.current === crepe) {
          crepeRef.current = null;
        }
      };
    }, []);

    useEffect(() => {
      highlightRef.current = highlightQuery;
      applyHighlight(highlightQuery);
    }, [highlightQuery]);

    return <div className="markdown-editor" data-testid="editor" ref={rootRef} />;
  }
);

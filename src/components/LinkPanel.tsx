/**
 * @req REQ-103 — 出链与反向引用面板。
 */
import type { Note } from '../domain/note';
import type { ResolvedLink } from '../domain/wikiLinks';

interface LinkPanelProps {
  outgoing: ResolvedLink[];
  backlinks: Array<{ note: Note; link: ResolvedLink }>;
  onOpen: (noteId: string) => void;
}

export function LinkPanel({ outgoing, backlinks, onOpen }: LinkPanelProps) {
  return (
    <div className="links-panel" data-testid="links-panel">
      <section>
        <h2>链接到</h2>
        {outgoing.length === 0 ? (
          <p className="panel-empty">没有双链</p>
        ) : (
          <ul className="link-list">
            {outgoing.map((link, index) =>
              link.noteId ? (
                <li key={`${link.target}-${index}`}>
                  <button
                    type="button"
                    className="link-item"
                    data-testid="outgoing-link"
                    onClick={() => onOpen(link.noteId as string)}
                  >
                    {link.noteTitle ?? link.label}
                  </button>
                </li>
              ) : (
                <li key={`${link.target}-${index}`}>
                  <span className="link-item broken" data-testid="broken-link">
                    {link.target}
                    {link.ambiguous ? '（同名歧义）' : '（未找到）'}
                  </span>
                </li>
              )
            )}
          </ul>
        )}
      </section>

      <section>
        <h2>被引用 <span>{backlinks.length}</span></h2>
        {backlinks.length === 0 ? (
          <p className="panel-empty">还没有笔记引用它</p>
        ) : (
          <ul className="link-list">
            {backlinks.map(({ note }) => (
              <li key={note.id}>
                <button
                  type="button"
                  className="link-item"
                  data-testid="backlink-link"
                  onClick={() => onOpen(note.id)}
                >
                  {note.title || '未命名笔记'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

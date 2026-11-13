/**
 * @req REQ-205 — AI 草稿面板：检索参考 → 生成草稿（预览）→ 用户确认后写入。
 */
import { useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import type { Note } from '../domain/note';
import type { AiSettings } from '../ai/settings';
import {
  baseUrlOrigin,
  describeRemoteSend,
  endpointBlockedReason,
  isLoopbackBaseUrl
} from '../ai/settings';
import { createChatProvider, createEmbeddingProvider } from '../ai/provider';
import { generateDraft, type DraftSuggestion } from '../ai/draft';
import { buildBm25Index, searchBm25 } from '../search/bm25';
import { hybridSearch } from '../search/vector';
import { createStoredNote } from '../storage/notes';
import { addManualRelation } from '../storage/relations';
import { notifyLocalChange } from '../sync/autoSync';

interface AiDraftPanelProps {
  notes: Note[];
  settings: AiSettings | null;
  onClose: () => void;
  onCreated: (note: Note) => void | Promise<void>;
}

export function AiDraftPanel({ notes, settings, onClose, onCreated }: AiDraftPanelProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [intent, setIntent] = useState('');
  const [draft, setDraft] = useState<DraftSuggestion | null>(null);
  const [sources, setSources] = useState<Note[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const generate = async () => {
    if (busy) return;
    if (!settings || !settings.enabled) {
      setMessage('先在 AI 设置里启用 AI 功能');
      return;
    }
    if (!intent.trim()) {
      setMessage('先写下想要生成什么');
      return;
    }
    setBusy(true);
    setMessage('');
    setDraft(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    try {
      const chatBlocked = endpointBlockedReason(settings.chat);
      if (chatBlocked) {
        setMessage(`对话端点不可用：${chatBlocked}`);
        return;
      }
      const index = buildBm25Index(notes);
      let picked: Note[] = [];
      if (settings.vectorSearchEnabled) {
        const embeddingBlocked = endpointBlockedReason(settings.embedding);
        if (embeddingBlocked) {
          setMessage(`嵌入端点不可用：${embeddingBlocked}`);
          return;
        }
        if (!isLoopbackBaseUrl(settings.embedding.baseUrl)) {
          const origin = baseUrlOrigin(settings.embedding.baseUrl);
          if (!window.confirm(`检索会把查询意图发送到 ${origin}。是否继续？`)) {
            setMessage('已取消：未发送检索请求');
            return;
          }
        }
        const embeddingProvider = createEmbeddingProvider(settings);
        const result = await hybridSearch(
          intent,
          index,
          settings,
          embeddingProvider,
          undefined,
          controller.signal
        );
        picked = result.hits
          .map((hit) => notes.find((note) => note.id === hit.noteId))
          .filter((note): note is Note => Boolean(note))
          .slice(0, 5);
      } else {
        picked = searchBm25(index, intent, 5)
          .map((hit) => notes.find((note) => note.id === hit.noteId))
          .filter((note): note is Note => Boolean(note));
      }
      setSources(picked);

      if (!isLoopbackBaseUrl(settings.chat.baseUrl)) {
        const characters = picked.reduce((sum, note) => sum + note.title.length + note.body.length, 0);
        const confirmed = window.confirm(
          `${describeRemoteSend(picked.length, characters)}目标：${baseUrlOrigin(settings.chat.baseUrl)}。是否继续生成草稿？`
        );
        if (!confirmed) {
          setMessage('已取消：未向远端发送内容');
          return;
        }
      }

      const chatProvider = createChatProvider(settings);
      const suggestion = await generateDraft(intent, picked, chatProvider, controller.signal);
      setDraft(suggestion);
      setMessage(`已生成草稿（参考 ${picked.length} 篇）；确认后才会写入正式数据。`);
    } catch (error: unknown) {
      setMessage(
        controller.signal.aborted
          ? '生成超时（30 秒），请重试'
          : `生成失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      window.clearTimeout(timer);
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!draft) return;
    setBusy(true);
    setMessage('');
    try {
      const created = await createStoredNote({ title: draft.title, body: draft.body });
      for (const relation of draft.relations) {
        await addManualRelation(created.id, relation.targetNoteId);
      }
      notifyLocalChange();
      await onCreated(created);
      onClose();
    } catch (error: unknown) {
      setMessage(`写入失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="sync-panel"
        data-testid="ai-draft-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI 草稿"
        tabIndex={-1}
      >
        <header className="version-header">
          <h2>AI 草稿</h2>
          <button type="button" data-testid="close-ai-draft" onClick={onClose}>
            关闭
          </button>
        </header>

        {!settings?.enabled && (
          <p className="sync-note" data-testid="ai-draft-disabled">
            先在 AI 设置里启用 AI 功能并配置服务地址。
          </p>
        )}

        <label className="sync-field">
          想要生成什么
          <textarea
            data-testid="ai-draft-intent"
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            rows={3}
            placeholder="例如：根据最近关于检索的笔记，写一篇混合检索的设计说明"
          />
        </label>

        <div className="sync-actions">
          <button
            type="button"
            className="primary"
            data-testid="ai-draft-generate"
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy && !draft ? '生成中…' : '生成草稿'}
          </button>
          <span data-testid="ai-draft-message">{message}</span>
        </div>

        {sources.length > 0 && (
          <p className="sync-note" data-testid="ai-draft-sources">
            参考：{sources.map((note) => note.title || '未命名笔记').join('、')}
          </p>
        )}

        {draft && (
          <div data-testid="ai-draft-preview">
            <label className="sync-field">
              草稿标题
              <input
                data-testid="ai-draft-title"
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
            <label className="sync-field">
              草稿正文
              <textarea
                data-testid="ai-draft-body"
                value={draft.body}
                onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                rows={8}
              />
            </label>
            {draft.relations.length > 0 && (
              <p className="sync-note" data-testid="ai-draft-relations">
                建议关联：
                {draft.relations
                  .map((relation) => {
                    const target = notes.find((note) => note.id === relation.targetNoteId);
                    return target ? target.title : relation.targetNoteId;
                  })
                  .join('、')}
              </p>
            )}
            <div className="sync-actions">
              <button
                type="button"
                className="primary"
                data-testid="ai-draft-confirm"
                disabled={busy}
                onClick={() => void confirm()}
              >
                确认写入
              </button>
              <button
                type="button"
                data-testid="ai-draft-discard"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setMessage('草稿已丢弃，未写入任何数据');
                }}
              >
                放弃草稿
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

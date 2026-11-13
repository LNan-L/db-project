/**
 * @req REQ-101 — 生产笔记编辑：标题、正文、保存、删除。
 * @req REQ-102 — Markdown 正文。
 */
import { useEffect, useRef, useState } from 'react';
import type { Note } from '../domain/note';
import type { Attachment } from '../storage/db';
import { deleteNote, updateNote } from '../storage/notes';
import { addAttachment, listAttachments, removeAttachment } from '../storage/attachments';
import { notifyLocalChange } from '../sync/autoSync';
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor';
import { VersionHistory } from './VersionHistory';
import { addTag, removeTag } from '../domain/tags';
import { attachmentIdsInMarkdown, toDisplayMarkdown, toStoredMarkdown } from '../markdown/attachmentRef';
import { db } from '../storage/db';
import { downloadAttachmentBlobWithProgress } from '../sync/blobs';
import {
  loadPrefetchMode,
  PREFETCH_CONCURRENCY,
  planPrefetch,
  runWithConcurrency
} from '../sync/attachmentPrefetch';
import {
  clearBlobFailure,
  markBlobFailure,
  pauseAllBlobRetries,
  subscribeBlobRetry
} from '../sync/blobStatus';
import { cancelAllBlobRetries, cancelBlobRetry, scheduleBlobRetry } from '../sync/blobRetry';
import { loadSyncConfig } from '../sync/sync';

interface NoteEditorProps {
  note: Note;
  /** 窄屏时返回列表（桌面端不显示该按钮）。 */
  onBack?: () => void;
  onSaved: (note: Note) => void | Promise<void>;
  onDeleted: () => void | Promise<void>;
  onOpenLink: (target: string) => void;
  highlightQuery?: string;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function NoteEditor({ note, onBack, onSaved, onDeleted, onOpenLink, highlightQuery = '' }: NoteEditorProps) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [originalDisplay, setOriginalDisplay] = useState(note.body);
  const loadedSignatureRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(note.updatedAt);
  const [tags, setTags] = useState(note.tags);
  const [tagInput, setTagInput] = useState('');
  const [folder, setFolder] = useState(note.folder);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [progressMap, setProgressMap] = useState<
    Record<string, { name: string; loaded: number; total: number }>
  >({});
  const [pendingDownloads, setPendingDownloads] = useState(0);
  const [attachmentSkipped, setAttachmentSkipped] = useState(0);
  const forceDownloadRef = useRef(false);
  const [attachmentError, setAttachmentError] = useState('');
  const [attachmentRetry, setAttachmentRetry] = useState<{
    attempts: number;
    nextRetryAt: number | null;
    exhausted: boolean;
  } | null>(null);
  const retryAttemptsRef = useRef<Map<string, number>>(new Map());
  // 同一个附件可能因 attachments 状态变化被 effect 再触发一次；避免并发重复下载。
  const inFlightRef = useRef<Set<string>>(new Set());
  const [downloadNonce, setDownloadNonce] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  const tagsChanged =
    tags.length !== note.tags.length || tags.some((tag, index) => tag !== note.tags[index]);
  useEffect(() => {
    let cancelled = false;
    listAttachments(note.id)
      .then((rows) => {
        if (!cancelled) setAttachments(rows);
      })
      .catch((error: unknown) => console.error('Load attachments failed', error));
    return () => {
      cancelled = true;
    };
  }, [note.id]);

  // 正文在编辑器里是"显示形式"（内联 data URL），存库是"引用形式"（attachment:<id>）
  const signature = `${note.id}::${note.body}`;
  useEffect(() => {
    if (loadedSignatureRef.current === signature) return;
    // 附件还没加载完时先等一轮，否则引用换不回图片
    if (attachments.length === 0 && note.body.includes('attachment:')) return;
    loadedSignatureRef.current = signature;
    let cancelled = false;
    void toDisplayMarkdown(note.body, attachments).then((display) => {
      if (cancelled) return;
      setOriginalDisplay(display);
      setBody(display);
      setEditorVersion((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [signature, note.body, attachments]);

  // 正文引用了附件但本地没有文件（别的设备加的图）→ 按需下载一次。
  // 手动重试会重置自动退避次数并取消待触发的定时器。
  useEffect(
    () =>
      subscribeBlobRetry(() => {
        cancelAllBlobRetries();
        retryAttemptsRef.current.clear();
        forceDownloadRef.current = true;
        setAttachmentRetry(null);
        setDownloadNonce((value) => value + 1);
      }),
    []
  );

  // 关闭笔记时取消退避定时器；失败记录留着，同步面板仍可手动重试。
  useEffect(
    () => () => {
      cancelAllBlobRetries();
      pauseAllBlobRetries();
    },
    []
  );

  useEffect(() => {
    const referenced = attachmentIdsInMarkdown(note.body);
    const missing = referenced.filter((id) => !attachments.some((row) => row.id === id));
    if (missing.length === 0) {
      setPendingDownloads(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mode = await loadPrefetchMode();
        const forced = forceDownloadRef.current;
        forceDownloadRef.current = false;
        if (mode === 'off' && !forced) {
          // 弱网模式：不动网络，只提示数量，等用户手动下载。
          setPendingDownloads(missing.length);
          return;
        }
        const config = await loadSyncConfig();
        if (!config.token || config.token.trim().length < 16) return;
        setPendingDownloads(0);
        const metas = (await Promise.all(missing.map((id) => db.attachment_refs.get(id)))).filter(
          (meta): meta is NonNullable<typeof meta> => Boolean(meta)
        );
        if (metas.length === 0) return;
        const byId = new Map(metas.map((meta) => [meta.id, meta]));
        // 单篇一次补齐，但守住「并发 2 + 总量 10 MB」；超出预算的留手动下载。
        const plan = planPrefetch(metas.map((meta) => ({ id: meta.id, size: meta.size })));
        setAttachmentSkipped(plan.skipped.length);
        setAttachmentError('');
        const results = await runWithConcurrency(
          plan.take,
          PREFETCH_CONCURRENCY,
          async ({ id }) => {
            const meta = byId.get(id);
            if (!meta || inFlightRef.current.has(id)) return false;
            inFlightRef.current.add(id);
            try {
              setProgressMap((current) => ({
                ...current,
                [id]: { name: meta.name, loaded: 0, total: meta.size }
              }));
              const attachment = await downloadAttachmentBlobWithProgress(
                config,
                { id, noteId: meta.noteId, name: meta.name, mime: meta.mime, hash: meta.hash },
                meta.size,
                (loaded, total) =>
                  setProgressMap((current) => ({
                    ...current,
                    [id]: { name: meta.name, loaded, total }
                  }))
              );
              if (!attachment) {
                setAttachmentError(meta.name);
                const attempts = (retryAttemptsRef.current.get(id) ?? 0) + 1;
                retryAttemptsRef.current.set(id, attempts);
                // 第一次失败等 5s，之后 15s / 60s / 300s；四次后不再自动重试。
                const delay = scheduleBlobRetry(id, attempts - 1, () =>
                  setDownloadNonce((value) => value + 1)
                );
                const nextRetryAt = delay === null ? null : Date.now() + delay;
                markBlobFailure(id, meta.name, { attempts, nextRetryAt, exhausted: delay === null });
                setAttachmentRetry({ attempts, nextRetryAt, exhausted: delay === null });
                return false;
              }
              await db.attachments.put(attachment);
              clearBlobFailure(id);
              cancelBlobRetry(id);
              retryAttemptsRef.current.delete(id);
              return true;
            } finally {
              inFlightRef.current.delete(id);
              setProgressMap((current) => {
                const next = { ...current };
                delete next[id];
                return next;
              });
            }
          }
        );
        const downloaded = results.filter(Boolean).length;
        const failed = results.length - downloaded;
        if (!cancelled && downloaded > 0) {
          loadedSignatureRef.current = null; // 让显示层重新把引用换成图片
          setAttachments(await listAttachments(note.id));
        }
        if (!cancelled && failed === 0 && downloaded > 0) {
          setAttachmentError('');
          setAttachmentRetry(null);
        }
      } catch (error) {
        console.error('Attachment download failed', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [note.id, note.body, attachments, downloadNonce]);

  const dirty =
    title !== note.title ||
    body !== originalDisplay ||
    tagsChanged ||
    folder.trim() !== (note.folder ?? '');

  const save = async () => {
    if (saving) return;
    const nextTitle = title.trim() || '未命名笔记';
    const displayBody = editorRef.current?.getMarkdown() ?? body;
    const storedBody = await toStoredMarkdown(displayBody, attachments);
    if (
      nextTitle === note.title &&
      storedBody === note.body &&
      !tagsChanged &&
      folder.trim() === (note.folder ?? '')
    ) {
      return;
    }

    setSaving(true);
    try {
      const updated = await updateNote(note.id, {
        title: nextTitle,
        body: storedBody,
        tags,
        folder: folder.trim()
      });
      if (updated) {
        loadedSignatureRef.current = `${note.id}::${updated.body}`;
        setTitle(updated.title);
        setBody(displayBody);
        setOriginalDisplay(displayBody);
        setBody(displayBody);
        setTags(updated.tags);
        setFolder(updated.folder);
        setLastSaved(updated.updatedAt);
        await onSaved(updated);
      }
    } catch (error: unknown) {
      console.error('Save note failed', error);
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  useEffect(() => {
    if (!dirty) return;
    const timer = window.setTimeout(() => {
      void saveRef.current();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, title, body, tags, folder]);

  const handleTagKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== ',') return;
    event.preventDefault();
    setTags((current) => addTag(current, tagInput));
    setTagInput('');
  };

  const handleAttachmentFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const images: string[] = [];
    for (const file of Array.from(fileList)) {
      await addAttachment(note.id, file);
      if (file.type.startsWith('image/') && file.size <= 1_000_000) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
        images.push(`![${file.name}](${dataUrl})`);
      }
    }
    setAttachments(await listAttachments(note.id));
    notifyLocalChange();
    if (images.length > 0) {
      const current = editorRef.current?.getMarkdown() ?? body;
      setBody(`${current.trimEnd()}\n\n${images.join('\n\n')}\n`);
      setEditorVersion((value) => value + 1);
    }
  };

  const handleRemoveAttachment = async (attachment: Attachment) => {
    if (!window.confirm(`移除附件「${attachment.name}」？`)) return;
    await removeAttachment(attachment.id);
    setAttachments(await listAttachments(note.id));
    notifyLocalChange();
  };

  const handleRestored = async (updated: Note) => {
    const display = await toDisplayMarkdown(updated.body, attachments);
    setTitle(updated.title);
    setBody(display);
    setOriginalDisplay(display);
    setTags(updated.tags);
    setFolder(updated.folder);
    setLastSaved(updated.updatedAt);
    setEditorVersion((value) => value + 1);
    await onSaved(updated);
  };

  const handleOpenLink = async (target: string) => {
    await saveRef.current();
    onOpenLink(target);
  };

  const handleDelete = async () => {
    if (!window.confirm(`确定删除「${note.title || '未命名笔记'}」？此操作不可撤销。`)) return;
    await deleteNote(note.id);
    await onDeleted();
  };

  const statusText = saving
    ? '保存中…'
    : dirty
      ? '有未保存修改'
      : `已保存 ${formatTime(lastSaved)}`;

  return (
    <section className="note-editor">
      <div className="editor-toolbar">
        <input
          className="note-title"
          data-testid="note-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="笔记标题"
          aria-label="笔记标题"
        />
        <div className="editor-actions">
          {onBack && (
            <button type="button" className="mobile-only" data-testid="mobile-back" onClick={onBack}>
              ‹ 列表
            </button>
          )}
          <span className="save-status" data-testid="save-status" role="status" aria-live="polite">
            {statusText}
          </span>
          <button type="button" data-testid="open-history" onClick={() => void saveRef.current().then(() => setHistoryOpen(true))}>
            历史
          </button>
          <button type="button" className="primary" data-testid="save-note" onClick={() => void saveRef.current()}>
            保存
          </button>
          <button type="button" className="danger" data-testid="delete-note" onClick={() => void handleDelete()}>
            删除
          </button>
        </div>
      </div>
      <div className="folder-editor">
        <span>文件夹</span>
        <input
          data-testid="note-folder"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="未分类（可输入新文件夹）"
          aria-label="文件夹"
        />
      </div>

      <div className="tag-editor" data-testid="tag-editor">
        {tags.map((tag) => (
          <span className="tag-chip" key={tag} data-testid="tag-chip">
            #{tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              onClick={() => setTags((current) => removeTag(current, tag))}
            >
              ×
            </button>
          </span>
        ))}
        <input
          className="tag-input"
          data-testid="tag-input"
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={handleTagKeyDown}
          placeholder="添加标签，回车"
          aria-label="添加标签"
        />
      </div>

      <div className="attachment-bar" data-testid="attachment-bar">
        {/*
         * 手机 PWA（独立窗口 / WebView）里，靠 label 隐式激活、甚至 input.click()
         * 都可能打不开文件选择器。所以让原生 input 透明覆盖在按钮上：
         * 手指直接点在原生控件上，由系统自己弹选择器，不经过任何 JS 转发。
         * 按钮保留给键盘和读屏用户（Enter 时走 onClick 的兜底路径）。
         */}
        <span className="attachment-add-wrap">
          <button
            type="button"
            className="attachment-add"
            data-testid="attachment-add"
            onClick={() => attachmentInputRef.current?.click()}
          >
            添加附件
          </button>
          <input
            ref={attachmentInputRef}
            type="file"
            className="attachment-input-overlay"
            data-testid="attachment-input"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(event) => {
              void handleAttachmentFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </span>
        {attachments.length === 0 ? (
          <span className="attachment-empty">无附件</span>
        ) : (
          attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.id} data-testid="attachment-chip">
              {attachment.name}
              <button
                type="button"
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() => void handleRemoveAttachment(attachment)}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>

      {Object.keys(progressMap).length > 0 && (
        <p className="sync-note" data-testid="attachment-progress">
          正在下载
          {Object.keys(progressMap).length > 1
            ? ` ${Object.keys(progressMap).length} 个附件`
            : ` ${Object.values(progressMap)[0]?.name ?? ''}`}
          ：
          {(() => {
            const rows = Object.values(progressMap);
            const loaded = rows.reduce((sum, row) => sum + row.loaded, 0);
            const total = rows.reduce((sum, row) => sum + Math.max(row.total, row.loaded), 0);
            return total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
          })()}
          %
        </p>
      )}
      {pendingDownloads > 0 && (
        <p className="sync-note" data-testid="attachment-pending">
          有 {pendingDownloads} 个附件未下载（弱网模式已停止自动预取）。
          <button
            type="button"
            data-testid="attachment-download-all"
            onClick={() => {
              forceDownloadRef.current = true;
              setDownloadNonce((value) => value + 1);
            }}
          >
            下载
          </button>
        </p>
      )}
      {attachmentSkipped > 0 && (
        <p className="sync-note" data-testid="attachment-skipped">
          另有 {attachmentSkipped} 个附件超过单篇预取上限（10 MB），未自动下载。
        </p>
      )}
      {attachmentError && (
        <p className="sync-note" data-testid="attachment-error">
          附件「{attachmentError}」下载失败
          {attachmentRetry
            ? attachmentRetry.exhausted
              ? `（已失败 ${attachmentRetry.attempts} 次，自动重试已停止）`
              : `（第 ${attachmentRetry.attempts} 次失败，稍后自动重试）`
            : ''}
          。
          <button
            type="button"
            data-testid="attachment-retry"
            onClick={() => {
              cancelAllBlobRetries();
              retryAttemptsRef.current.clear();
              forceDownloadRef.current = true;
              setAttachmentRetry(null);
              setDownloadNonce((value) => value + 1);
            }}
          >
            重试
          </button>
        </p>
      )}

      <MarkdownEditor
        ref={editorRef}
        key={`${note.id}-${editorVersion}`}
        initialMarkdown={body}
        onChange={(markdown) => setBody(markdown)}
        onOpenLink={(target) => void handleOpenLink(target)}
        highlightQuery={highlightQuery}
      />
      <p className="editor-hint">Markdown 原样保存；这是 Phase 1 生产实现。</p>

      {historyOpen && (
        <VersionHistory
          note={note}
          onClose={() => setHistoryOpen(false)}
          onRestored={handleRestored}
        />
      )}
    </section>
  );
}

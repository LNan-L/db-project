/**
 * @req REQ-303 — 版本历史面板（本机 + 云端合并）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import type { Note } from '../domain/note';
import { updateNote } from '../storage/notes';
import type { NoteVersion } from '../storage/db';
import { listVersions, restoreVersion } from '../storage/versions';
import { loadSyncConfig } from '../sync/sync';
import {
  buildTimeline,
  fetchRemoteVersionsPage,
  type RemoteVersion,
  type TimelineVersion
} from '../sync/versions';

const PAGE_SIZE = 50;

interface VersionHistoryProps {
  note: Note;
  onClose: () => void;
  onRestored: (note: Note) => void | Promise<void>;
}

// 旧版本可能内联了 data: URL 图片，预览里只显示占位，避免整屏 base64。
function preview(body: string): string {
  const dataUrlPattern = new RegExp('!\\[([^\\]]*)\\]\\(data:[^)]+\\)', 'g');
  const text = body.replace(dataUrlPattern, '![$1]（内联图片）').trim();
  return text ? text.slice(0, 120) : '（空正文）';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

export function VersionHistory({ note, onClose, onRestored }: VersionHistoryProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [items, setItems] = useState<TimelineVersion[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [remote, setRemote] = useState<RemoteVersion[]>([]);
  const [localVersions, setLocalVersions] = useState<NoteVersion[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    const local = await listVersions(note.id);
    setLocalVersions(local);
    let page: { versions: RemoteVersion[]; nextCursor: number | null } = {
      versions: [],
      nextCursor: null
    };
    try {
      const config = await loadSyncConfig();
      if (config.token && config.token.trim().length >= 16) {
        page = await fetchRemoteVersionsPage(config, note.id, { limit: PAGE_SIZE });
      }
    } catch (error) {
      setMessage(`云端版本读取失败：${String(error)}`);
    }
    setRemote(page.versions);
    setCursor(page.nextCursor);
    setItems(buildTimeline(local, page.versions));
  }, [note.id]);

  /** 只追加比当前更早的云端版本；本地版本已在内存里，不重复拉。 */
  const loadMore = async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const config = await loadSyncConfig();
      if (!config.token || config.token.trim().length < 16) return;
      const page = await fetchRemoteVersionsPage(config, note.id, {
        before: cursor,
        limit: PAGE_SIZE
      });
      const seen = new Set(remote.map((version) => version.id));
      const merged = [...remote, ...page.versions.filter((version) => !seen.has(version.id))];
      setRemote(merged);
      setCursor(page.nextCursor);
      setItems(buildTimeline(localVersions, merged));
    } catch (error) {
      setMessage(`加载更多历史失败：${String(error)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void load().catch((error: unknown) => {
      if (!cancelled) setMessage(`读取版本失败：${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const handleRestore = async (item: TimelineVersion) => {
    if (!window.confirm(`恢复到 ${formatTime(item.createdAt)} 的版本？当前内容会先保存为历史。`)) {
      return;
    }
    setBusy(true);
    try {
      let updated: Note | undefined;
      if (item.source === 'remote') {
        updated = await updateNote(note.id, {
          title: item.title,
          body: item.body,
          tags: item.tags,
          folder: item.folder
        });
      } else {
        const local = await listVersions(note.id);
        const target = local.find((version) => `local:${version.id}` === item.key);
        updated = target ? await restoreVersion(target) : undefined;
      }
      if (updated) {
        await onRestored(updated);
        await load();
        setMessage('已恢复；当前版本已写入历史。');
      }
    } catch (error: unknown) {
      setMessage(`恢复失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="version-panel"
        data-testid="version-panel"
        role="dialog"
        aria-modal="true"
        aria-label="版本历史"
        tabIndex={-1}
      >
        <header className="version-header">
          <h2>版本历史</h2>
          <button type="button" data-testid="close-history" onClick={onClose}>
            关闭
          </button>
        </header>
        {message && <p className="version-message">{message}</p>}
        {remote.length > 0 && (
          <p className="version-message" data-testid="version-remote-count">
            云端历史已加载 {remote.length} 条（来自其他设备）
          </p>
        )}
        {cursor !== null && (
          <button
            type="button"
            className="version-load-more"
            data-testid="version-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? '加载中…' : '加载更多云端历史'}
          </button>
        )}
        {items.length === 0 ? (
          <p className="version-empty">还没有历史版本；保存修改后会生成。</p>
        ) : (
          <ul className="version-list" data-testid="version-list">
            {items.map((item) => (
              <li key={item.key} data-testid="version-item" className="version-item">
                <div className="version-meta">
                  <strong>{item.title || '未命名笔记'}</strong>
                  <span data-testid="version-source">{item.source === 'remote' ? '云端' : '本机'}</span>
                  <span>{formatTime(item.createdAt)}</span>
                </div>
                <p className="version-preview">
                  {preview(item.body)}
                </p>
                <button
                  type="button"
                  data-testid="restore-version"
                  disabled={busy}
                  onClick={() => void handleRestore(item)}
                >
                  恢复此版本
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

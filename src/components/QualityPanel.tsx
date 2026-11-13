/**
 * @req REQ-304 — 质量分析面板：列出重复/孤立/断链，处理动作逐项确认。
 */
import { useEffect, useMemo, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import type { Note } from '../domain/note';
import type { ManualRelation } from '../storage/db';
import { listManualRelations } from '../storage/relations';
import { fetchAuditLogs, type AuditLogEntry } from '../sync/sync';
import { analyzeQuality, type BrokenLink, type DuplicatePair } from '../quality/analyze';
import { createMissingTarget, mergeDuplicateNotes } from '../quality/actions';

interface QualityPanelProps {
  notes: Note[];
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onChanged: () => void | Promise<void>;
}

type PendingAction =
  | { kind: 'merge'; pair: DuplicatePair }
  | { kind: 'create'; link: BrokenLink };

export function QualityPanel({ notes, onClose, onOpenNote, onChanged }: QualityPanelProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [relations, setRelations] = useState<ManualRelation[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [audit, setAudit] = useState<AuditLogEntry[] | null>(null);
  const [auditError, setAuditError] = useState('');

  const report = useMemo(() => analyzeQuality(notes, relations), [notes, relations]);

  useEffect(() => {
    let cancelled = false;
    void listManualRelations()
      .then((rows) => {
        if (!cancelled) setRelations(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [notes]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    void fetchAuditLogs(10, fetch, undefined, controller.signal)
      .then((rows) => {
        if (!cancelled) {
          setAudit(rows);
          setAuditError('');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setAuditError(String(error instanceof Error ? error.message : error));
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const reload = async () => {
    setRelations(await listManualRelations());
    await onChanged();
  };

  const run = async (action: 'merge' | 'create') => {
    if (!pending || busy) return;
    setBusy(true);
    setMessage('');
    try {
      if (action === 'merge' && pending.kind === 'merge') {
        await mergeDuplicateNotes(pending.pair.keepId, pending.pair.dropId);
        setMessage(`已合并「${pending.pair.keepTitle}」与「${pending.pair.dropTitle}」`);
        setPending(null);
      }
      if (action === 'create' && pending.kind === 'create') {
        await createMissingTarget(pending.link.target);
        setMessage(`已创建目标笔记「${pending.link.target}」`);
        setPending(null);
      }
      await reload();
    } catch (error: unknown) {
      setMessage(`处理失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="sync-panel quality-panel"
        data-testid="quality-panel"
        role="dialog"
        aria-modal="true"
        aria-label="质量分析"
        tabIndex={-1}
      >
        <header className="version-header">
          <h2>质量分析</h2>
          <button type="button" data-testid="close-quality" onClick={onClose}>
            关闭
          </button>
        </header>

        <p className="sync-note" data-testid="quality-summary">
          共 {report.summary.notes} 篇 · 重复 {report.summary.duplicates} · 孤立{' '}
          {report.summary.orphans} · 断链 {report.summary.brokenLinks}
        </p>

        <section data-testid="quality-duplicates">
          <h3>重复（{report.duplicates.length}）</h3>
          {report.duplicates.length === 0 && <p className="sync-note">没有发现重复笔记。</p>}
          {report.duplicates.map((pair, index) => (
            <div className="quality-row" key={`${pair.keepId}:${pair.dropId}`}>
              <span>
                「{pair.keepTitle || '未命名'}」与「{pair.dropTitle || '未命名'}」
                {pair.reason === 'same-title' ? '（标题相同）' : `（相似度 ${pair.score}）`}
              </span>
              <button
                type="button"
                data-testid={`quality-merge-${index}`}
                disabled={busy}
                onClick={() => setPending({ kind: 'merge', pair })}
              >
                合并
              </button>
            </div>
          ))}
          {pending?.kind === 'merge' && (
            <div className="sync-actions" data-testid="quality-merge-confirm-row">
              <span className="sync-note">
                确认合并？保留「{pending.pair.keepTitle || '未命名'}」，删除「
                {pending.pair.dropTitle || '未命名'}」；正文/标签会并入，有版本历史与墓碑。
              </span>
              <button
                type="button"
                className="primary"
                data-testid="quality-merge-confirm"
                disabled={busy}
                onClick={() => void run('merge')}
              >
                确认合并
              </button>
              <button
                type="button"
                data-testid="quality-merge-cancel"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消
              </button>
            </div>
          )}
        </section>

        <section data-testid="quality-orphans">
          <h3>孤立（{report.orphans.length}）</h3>
          {report.orphans.length === 0 && <p className="sync-note">没有孤立笔记。</p>}
          {report.orphans.map((note) => (
            <div className="quality-row" key={note.id}>
              <span>「{note.title || '未命名'}」没有任何出链、入链或手动关系</span>
              <button type="button" onClick={() => onOpenNote(note.id)}>
                打开
              </button>
            </div>
          ))}
        </section>

        <section data-testid="quality-broken">
          <h3>断链（{report.brokenLinks.length}）</h3>
          {report.brokenLinks.length === 0 && <p className="sync-note">没有断链。</p>}
          {report.brokenLinks.map((link, index) => (
            <div className="quality-row" key={`${link.sourceId}:${link.target}`}>
              <span>
                「{link.sourceTitle || '未命名'}」→ [[{link.target}]]
              </span>
              <button
                type="button"
                data-testid={`quality-create-${index}`}
                disabled={busy}
                onClick={() => setPending({ kind: 'create', link })}
              >
                创建目标笔记
              </button>
            </div>
          ))}
          {pending?.kind === 'create' && (
            <div className="sync-actions" data-testid="quality-create-confirm-row">
              <span className="sync-note">
                确认创建标题为「{pending.link.target}」的空笔记？原链接会自动解析。
              </span>
              <button
                type="button"
                className="primary"
                data-testid="quality-create-confirm"
                disabled={busy}
                onClick={() => void run('create')}
              >
                确认创建
              </button>
              <button
                type="button"
                data-testid="quality-create-cancel"
                disabled={busy}
                onClick={() => setPending(null)}
              >
                取消
              </button>
            </div>
          )}
        </section>

        <section data-testid="quality-audit">
          <h3>审计日志（最近 10 条）</h3>
          {auditError && (
            <p className="sync-note">
              审计日志不可用：{auditError}（需要同步连接与 token）
            </p>
          )}
          {!auditError && audit && audit.length === 0 && (
            <p className="sync-note">暂无审计记录。</p>
          )}
          {!auditError && audit && audit.length > 0 && (
            <ul className="quality-audit-list">
              {audit.map((entry) => (
                <li key={entry.id}>
                  {new Date(entry.at).toLocaleString('zh-CN')} · {entry.tool} ·{' '}
                  {entry.result}
                  {entry.noteId ? ` · ${entry.noteId.slice(0, 8)}` : ''}
                </li>
              ))}
            </ul>
          )}
          {!auditError && !audit && <p className="sync-note">读取审计日志…</p>}
        </section>

        {message && (
          <p className="sync-note" data-testid="quality-message">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}

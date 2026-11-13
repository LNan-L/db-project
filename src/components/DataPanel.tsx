/**
 * @req REQ-601/602/603/604/605 — 生产同机备份面板。
 */
import { useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import type { Note } from '../domain/note';
import { ensureSchema, type ManualRelation } from '../storage/db';
import { listCanvasCards } from '../storage/canvas';
import { listAllAttachments } from '../storage/attachments';
import { getMetaValue, setMetaValue } from '../storage/meta';
import {
  applyImportPlan,
  buildExportPackage,
  parseMarkdownFiles,
  parsePackage,
  planImport,
  planMarkdownImport,
  readPackageSchema,
  type ConflictResolution,
  type ImportPlan
} from '../backup/package';
import {
  importPrototypePackage,
  parsePrototypePackage
} from '../migration/prototypePackage';
import { downloadBlob } from '../backup/download';
import { decryptBackup, encryptBackup, isEncryptedBackup, rekeyBackup } from '../backup/crypto';
import { sha256Hex } from '../migration/hash';
import { needsBackupReminder } from '../backup/reminder';

const LAST_EXPORT_KEY = 'last_export_at';

type PersistState = 'unknown' | 'granted' | 'denied' | 'unsupported';

interface DataPanelProps {
  notes: Note[];
  manualRelations: ManualRelation[];
  onClose: () => void;
  onImported: () => void | Promise<void>;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '不可用';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DataPanel({ notes, manualRelations, onClose, onImported }: DataPanelProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [persistState, setPersistState] = useState<PersistState>('unknown');
  const [usage, setUsage] = useState<number | undefined>(undefined);
  const [quota, setQuota] = useState<number | undefined>(undefined);
  const [lastExportAt, setLastExportAt] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fileName, setFileName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [rekeyFile, setRekeyFile] = useState<File | null>(null);
  const [rekeyNewSecret, setRekeyNewSecret] = useState('');
  const [rekeyBusy, setRekeyBusy] = useState(false);
  const [backupHash, setBackupHash] = useState('');
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [prototypeImport, setPrototypeImport] = useState<{
    bytes: Uint8Array;
    notes: number;
    skipped: number;
    attachments: number;
    links: number;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      await ensureSchema();
      const last = await getMetaValue(LAST_EXPORT_KEY);
      if (!cancelled) setLastExportAt(last);
      if (!navigator.storage) {
        if (!cancelled) setPersistState('unsupported');
        return;
      }
      if (typeof navigator.storage.persisted === 'function') {
        const persisted = await navigator.storage.persisted();
        if (!cancelled) setPersistState(persisted ? 'granted' : 'denied');
      }
      if (typeof navigator.storage.estimate === 'function') {
        const estimate = await navigator.storage.estimate();
        if (!cancelled) {
          setUsage(estimate.usage);
          setQuota(estimate.quota);
        }
      }
    }
    void load().catch((error: unknown) => setMessage(`读取存储状态失败：${String(error)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  const persistLabel =
    persistState === 'granted'
      ? '已持久化'
      : persistState === 'denied'
        ? '未持久化'
        : persistState === 'unsupported'
          ? '浏览器不支持'
          : '读取中…';

  const requestPersist = async () => {
    if (!navigator.storage?.persist) {
      setMessage('浏览器不支持持久化请求');
      return;
    }
    const granted = await navigator.storage.persist();
    setPersistState(granted ? 'granted' : 'denied');
    setMessage(granted ? '持久化请求已获批准' : '持久化请求返回 false，不视为成功');
  };

  const buildEncryptedBackup = async () => {
    const trimmed = secret.trim();
    if (trimmed.length < 12) throw new Error('备份口令至少 12 位（恢复码也可用）');
    const attachments = await listAllAttachments();
    // B-3：画布布局也进备份，恢复后不必重摆。
    const canvasCards = await listCanvasCards().catch(() => []);
    const pkg = await buildExportPackage(notes, { attachments, manualRelations, canvasCards });
    const zip = new Uint8Array(await pkg.blob.arrayBuffer());
    const encrypted = await encryptBackup(zip, trimmed);
    const bytes = new Uint8Array(encrypted.data.byteLength);
    bytes.set(encrypted.data);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    return {
      blob,
      fileName: pkg.fileName.replace(/\.zip$/, '.pke.enc'),
      recoveryCode: encrypted.recoveryCode,
      hash: await sha256Hex(bytes),
      noteCount: pkg.manifest.notes.length,
      attachmentCount: pkg.manifest.attachments.length
    };
  };

  const finishExport = async (backup: Awaited<ReturnType<typeof buildEncryptedBackup>>) => {
    const timestamp = new Date().toISOString();
    setRecoveryConfirmed(false);
    await setMetaValue(LAST_EXPORT_KEY, timestamp);
    setLastExportAt(timestamp);
    setRecoveryCode(backup.recoveryCode);
    setBackupHash(backup.hash);
    setMessage(
      `已导出 ${backup.noteCount} 篇笔记、${backup.attachmentCount} 个附件（加密包）。` +
        ' 恢复码只显示一次，请与口令分开保存；同机演练不等于跨设备。'
    );
  };

  /**
   * @req B-6 — 更换备份口令：用旧口令解开 DEK，再用新口令重包，数据密文不变。
   * 旧恢复码随之作废，这里会显示新的恢复码（只显示一次）。
   */
  const handleRekey = async () => {
    if (!rekeyFile || rekeyBusy) return;
    if (rekeyNewSecret.trim().length < 12) {
      setMessage('新口令至少 12 位');
      return;
    }
    if (secret.trim().length < 12) {
      setMessage('请先在上方填写当前备份的口令或恢复码');
      return;
    }
    setRekeyBusy(true);
    setMessage('');
    try {
      const bytes = new Uint8Array(await rekeyFile.arrayBuffer());
      if (!isEncryptedBackup(bytes)) throw new Error('这个文件不是 PKE 加密备份');
      const result = await rekeyBackup(bytes, secret.trim(), rekeyNewSecret.trim());
      const copy = new Uint8Array(result.data.byteLength);
      copy.set(result.data);
      const blob = new Blob([copy], { type: 'application/octet-stream' });
      const fileName = rekeyFile.name.replace(/\.pke\.enc$/, '') + '-rekeyed.pke.enc';
      downloadBlob(blob, fileName);
      setRecoveryCode(result.recoveryCode);
      setRecoveryConfirmed(false);
      setBackupHash(await sha256Hex(copy));
      setMessage(
        `已用新口令重包 ${rekeyFile.name}：内容未重新加密（同一份数据密钥），旧恢复码已作废。` +
          ' 请保存新包与新的恢复码，旧的 .pke.enc 可删除。'
      );
      setRekeyFile(null);
      setRekeyNewSecret('');
    } catch (error: unknown) {
      setMessage(`更换口令失败：${String(error)}`);
    } finally {
      setRekeyBusy(false);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    setMessage('');
    try {
      const backup = await buildEncryptedBackup();
      downloadBlob(backup.blob, backup.fileName);
      await finishExport(backup);
    } catch (error: unknown) {
      setMessage(`导出失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleExportDirectory = async () => {
    const picker = (window as unknown as {
      showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<{
        getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
          createWritable: () => Promise<{
            write: (data: Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      }>;
    }).showDirectoryPicker;
    if (!picker) {
      setMessage('当前浏览器不支持选择网盘目录，请用“导出加密备份”下载后放入网盘。');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const directory = await picker({ mode: 'readwrite' });
      const backup = await buildEncryptedBackup();
      const handle = await directory.getFileHandle(backup.fileName, { create: true });
      const writable = await handle.createWritable();
      await writable.write(backup.blob);
      await writable.close();
      await finishExport(backup);
    } catch (error: unknown) {
      setMessage(`写入备份目录失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    if (recoveryCode && !recoveryConfirmed) {
      const confirmed = window.confirm(
        '恢复码尚未确认保存。关闭后本次恢复码无法再次查看，确定关闭？'
      );
      if (!confirmed) return;
    }
    onClose();
  };

  const downloadRecovery = () => {
    if (!recoveryCode) return;
    const content = [
      'PKE 一次性恢复码',
      '',
      recoveryCode,
      '',
      '用途：忘记备份口令时，用它导入对应的 .pke.enc。',
      '注意：不要和备份文件放在同一目录；丢失后无法恢复。',
      `生成时间：${new Date().toISOString()}`
    ].join('\n');
    downloadBlob(
      new Blob([content], { type: 'text/plain;charset=utf-8' }),
      `pke-recovery-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
    );
    setMessage('恢复码文件已下载；请把它和备份文件分开保存。');
  };

  const copyRecovery = async () => {
    if (!recoveryCode) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setMessage('恢复码已复制。请粘贴到密码管理器，不要和备份放一起。');
    } catch {
      setMessage('复制失败；请用“下载恢复码”保存。');
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    setMessage('');
    setPlan(null);
    setConflictResolutions({});
    setPrototypeImport(null);
    setFileName(files.map((file) => file.name).join(', '));
    try {
      if (files.length === 1) {
        let bytes: Uint8Array = new Uint8Array(await files[0]!.arrayBuffer());
        if (isEncryptedBackup(bytes)) {
          if (secret.trim().length < 12) throw new Error('请输入备份口令或恢复码');
          bytes = await decryptBackup(bytes, secret.trim());
        }
        if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
          const schema = readPackageSchema(bytes);
          if (schema === 5) {
            const parsed = await parsePrototypePackage(bytes);
            const existingIds = new Set(notes.map((note) => note.id));
            const notesToCreate = parsed.notes.filter((note) => !existingIds.has(note.id));
            setPrototypeImport({
              bytes,
              notes: notesToCreate.length,
              skipped: parsed.notes.length - notesToCreate.length,
              attachments: parsed.attachments.length,
              links: parsed.links.length
            });
            return;
          }
          const parsed = await parsePackage(bytes);
          setPlan(planImport(parsed, notes));
          return;
        }
      }
      const texts = await Promise.all(
        files.map(async (file) => ({ name: file.name, text: await file.text() }))
      );
      const imported = parseMarkdownFiles(texts);
      if (imported.length === 0) throw new Error('没有可导入的 Markdown 文件');
      setPlan(planMarkdownImport(imported, notes));
    } catch (error: unknown) {
      setMessage(`读取导入文件失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!plan && !prototypeImport) return;
    setBusy(true);
    try {
      if (prototypeImport) {
        const summary = await importPrototypePackage(prototypeImport.bytes);
        await onImported();
        setPrototypeImport(null);
        if (fileRef.current) fileRef.current.value = '';
        setMessage(
          `原型包导入完成：笔记 ${summary.notesImported}，跳过 ${summary.notesSkipped}，` +
            `附件 ${summary.attachmentsImported}，关系 ${summary.linksImported}。`
        );
        return;
      }
      const summary = await applyImportPlan(plan!, conflictResolutions);
      await onImported();
      setPlan(null);
      if (fileRef.current) fileRef.current.value = '';
      setMessage(
        `导入完成：新增 ${summary.notesImported}，跳过 ${summary.notesSkipped}，` +
          `路径拒绝 ${summary.pathRejected}，关系 ${summary.linksImported + summary.relationsImported}，冲突处理 ${summary.conflictsResolved}。`
      );
    } catch (error: unknown) {
      setMessage(`导入失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const reminder = needsBackupReminder(lastExportAt);

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="data-panel"
        data-testid="data-panel"
        role="dialog"
        aria-modal="true"
        aria-label="数据与备份"
        tabIndex={-1}
      >
        <header className="data-panel-header">
          <h2>数据与备份</h2>
          <button type="button" onClick={handleClose} data-testid="close-data" autoFocus>
            关闭
          </button>
        </header>

        {reminder && (
          <div className="backup-reminder" data-testid="backup-reminder">
            超过 7 天没有生成可恢复副本。可恢复副本能防清缓存/误删，不能防设备丢失；不宣称后台自动备份。
          </div>
        )}

        <section className="data-section">
          <h3>浏览器存储</h3>
          <dl className="data-grid">
            <dt>持久化状态</dt>
            <dd data-testid="storage-status">{persistLabel}</dd>
            <dt>已用 / 配额</dt>
            <dd>{formatBytes(usage)} / {formatBytes(quota)}</dd>
            <dt>最近导出</dt>
            <dd data-testid="last-export">
              {lastExportAt ? new Date(lastExportAt).toLocaleString('zh-CN') : '从未导出'}
            </dd>
          </dl>
          <button type="button" onClick={() => void requestPersist()} data-testid="storage-persist">
            请求持久化
          </button>
        </section>

        <section className="data-section">
          <h3>加密可恢复副本（OPEN-011 B）</h3>
          <label className="secret-label">
            备份口令 / 恢复码
            <input
              type="password"
              data-testid="backup-secret"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="至少 12 位；导入时也可用恢复码"
            />
          </label>
          <div className="data-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void handleExport()}
              disabled={busy || notes.length === 0}
              data-testid="export-data"
            >
              导出加密备份
            </button>
            <button
              type="button"
              onClick={() => void handleExportDirectory()}
              disabled={busy || notes.length === 0}
              data-testid="export-directory"
            >
              选择网盘目录并导出
            </button>
            <label className="import-label">
              导入加密备份 / ZIP / Markdown
              <input
                ref={fileRef}
                type="file"
                accept=".pke.enc,.zip,.md,.markdown,text/markdown,application/zip,application/octet-stream"
                multiple
                data-testid="import-file"
                onChange={(event) => void handleFiles(event.target.files)}
              />
            </label>
          </div>
          <p className="data-note">
            AES-256-GCM + PBKDF2；导出包含 Markdown、附件、manifest、schema_version、画布布局和 hash。
            口令/恢复码丢失则无法恢复；不宣称跨设备已验证。
          </p>

          <div className="data-section" data-testid="rekey-section">
            <h4>更换备份口令（B-6）</h4>
            <p className="data-note">
              只需读取旧包 + 新口令：数据密文不重新加密，恢复码会同时更换，旧恢复码作废。
            </p>
            <label className="import-label">
              选择现有 .pke.enc
              <input
                type="file"
                accept=".pke.enc,application/octet-stream"
                data-testid="rekey-file"
                onChange={(event) => setRekeyFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <label className="secret-label">
              新口令（至少 12 位）
              <input
                type="password"
                data-testid="rekey-new-secret"
                value={rekeyNewSecret}
                onChange={(event) => setRekeyNewSecret(event.target.value)}
                placeholder="新口令，旧口令用上方输入框"
              />
            </label>
            <div className="data-actions">
              <button
                type="button"
                data-testid="rekey-run"
                disabled={rekeyBusy || !rekeyFile}
                onClick={() => void handleRekey()}
              >
                {rekeyBusy ? '更换中…' : '生成新口令的备份'}
              </button>
            </div>
          </div>
          {notes.length === 0 && (
            <p className="data-warning" data-testid="export-hint">
              当前没有笔记，导出按钮不可用。先在左侧「新建笔记」，或用「导入」把旧数据导进来。
            </p>
          )}
          {recoveryCode && (
            <div className="recovery-box">
              <strong>一次性恢复码（只显示一次）</strong>
              <code data-testid="recovery-code">{recoveryCode}</code>
              <div className="recovery-actions">
                <button type="button" onClick={downloadRecovery} data-testid="download-recovery">
                  下载恢复码 .txt
                </button>
                <button type="button" onClick={() => void copyRecovery()} data-testid="copy-recovery">
                  复制恢复码
                </button>
              </div>
              <label className="recovery-confirm">
                <input
                  type="checkbox"
                  data-testid="recovery-confirmed"
                  checked={recoveryConfirmed}
                  onChange={(event) => setRecoveryConfirmed(event.target.checked)}
                />
                我已把恢复码保存到安全位置，并确认它和备份文件分开
              </label>
            </div>
          )}
          {backupHash && (
            <p className="data-note" data-testid="backup-hash">
              加密包 SHA-256：{backupHash}
            </p>
          )}
        </section>

        {plan && (
          <section className="data-section" data-testid="import-preview">
            <h3>导入预览：{fileName}</h3>
            <p>
              新增 {plan.notesToCreate.length}；跳过 {plan.notesSkipped}；
              路径拒绝 {plan.pathRejected}；冲突 {plan.conflicts.length}；
              关系 {plan.linksToCreate.length + plan.relationsToCreate.length}；
              附件 {plan.attachmentsToCreate.length}。
            </p>
            {plan.conflicts.map((conflict) => (
              <div className="conflict-item" data-testid="conflict-item" key={conflict.local.id}>
                <strong>{conflict.local.title || '未命名笔记'}</strong>
                <div className="conflict-sides">
                  <div>
                    <span>本地</span>
                    <p>{conflict.local.body.slice(0, 160) || '（空正文）'}</p>
                  </div>
                  <div>
                    <span>远端</span>
                    <p>{conflict.remote.body.slice(0, 160) || '（空正文）'}</p>
                  </div>
                </div>
                <div className="conflict-actions">
                  <button
                    type="button"
                    data-testid="conflict-local"
                    className={conflictResolutions[conflict.local.id] === 'local' ? 'active' : ''}
                    onClick={() =>
                      setConflictResolutions((current) => ({
                        ...current,
                        [conflict.local.id]: 'local'
                      }))
                    }
                  >
                    保留本地
                  </button>
                  <button
                    type="button"
                    data-testid="conflict-remote"
                    className={conflictResolutions[conflict.local.id] === 'remote' ? 'active' : ''}
                    onClick={() =>
                      setConflictResolutions((current) => ({
                        ...current,
                        [conflict.local.id]: 'remote'
                      }))
                    }
                  >
                    使用远端
                  </button>
                  <button
                    type="button"
                    data-testid="conflict-copy"
                    className={conflictResolutions[conflict.local.id] === 'copy' ? 'active' : ''}
                    onClick={() =>
                      setConflictResolutions((current) => ({
                        ...current,
                        [conflict.local.id]: 'copy'
                      }))
                    }
                  >
                    生成冲突副本
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="primary"
              onClick={() => void confirmImport()}
              disabled={
                busy ||
                (plan.notesToCreate.length === 0 && plan.conflicts.length === 0) ||
                plan.conflicts.some((conflict) => !conflictResolutions[conflict.local.id])
              }
              data-testid="confirm-import"
            >
              确认写入（新增 {plan.notesToCreate.length} / 冲突 {plan.conflicts.length}）
            </button>
          </section>
        )}

        {prototypeImport && (
          <section className="data-section" data-testid="import-preview">
            <h3>原型包导入预览：{fileName}</h3>
            <p>
              新增 {prototypeImport.notes}；跳过 {prototypeImport.skipped}；
              附件 {prototypeImport.attachments}；关系 {prototypeImport.links}。
            </p>
            <p className="data-note">
              这是 Phase 0 原型 schema 5 导出包；导入会保留 ID、正文、标签、文件夹、附件 hash 和关系。
            </p>
            <button
              type="button"
              className="primary"
              onClick={() => void confirmImport()}
              disabled={busy || prototypeImport.notes === 0}
              data-testid="confirm-import"
            >
              确认写入（新增 {prototypeImport.notes}）
            </button>
          </section>
        )}

        {message && (
          <p className="data-message" data-testid="data-message" role="status" aria-live="polite">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}

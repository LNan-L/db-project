/**
 * @req REQ-204 / REQ-303 — 多设备同步面板与冲突处理。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import {
  issueDeviceToken,
  loadSyncConfig,
  saveSyncConfig,
  resolveSyncConflict,
  type SyncConfig,
  type SyncConflict,
  type SyncConflictChoice
} from '../sync/sync';
import { autoSync, type AutoSyncState } from '../sync/autoSync';
import {
  fetchDeviceRegistry,
  restoreDevice,
  revokeDevice,
  type RemoteDevice,
  type RevokedDevice
} from '../sync/devices';
import { buildSyncLink } from '../sync/shareConfig';
import { listBlobFailures, requestBlobRetry, subscribeBlobFailures, type BlobFailure } from '../sync/blobStatus';
import { loadPrefetchMode, savePrefetchMode } from '../sync/attachmentPrefetch';
import { db } from '../storage/db';

interface SyncPanelProps {
  /** 本次面板是由扫码链接打开的（用于给出可见反馈）。 */
  importedFromLink?: boolean;
  onClose: () => void;
  onSynced: () => void | Promise<void>;
}

function formatTime(iso: string | null): string {
  if (!iso) return '从未同步';
  return new Date(iso).toLocaleString('zh-CN');
}

function autoLabel(state: AutoSyncState, token: string): string {
  const seconds = state.nextRetryMs ? Math.round(state.nextRetryMs / 1000) : null;
  switch (state.status) {
    case 'unconfigured':
      // 引擎状态可能停在配置加载之前，这里以当前 token 为准
      return token.trim().length >= 16
        ? '自动同步已就绪（下次保存笔记即触发）。'
        : '自动同步：填好服务器地址和 token 后自动开启。';
    case 'pending':
      return '自动同步：本地有改动，稍后自动同步…';
    case 'syncing':
      return '自动同步：同步中…';
    case 'error':
      return `自动同步失败：${state.lastError ?? ''}${seconds ? `（${seconds} 秒后重试，第 ${state.retries} 次）` : ''}`;
    case 'offline':
      return '自动同步：当前离线，恢复网络后自动同步。';
    case 'conflict':
      return `自动同步：发现 ${state.conflicts.length} 个冲突，等待你选择。`;
    default:
      return state.lastSuccessAt
        ? `自动同步已开启（上次成功 ${new Date(state.lastSuccessAt).toLocaleTimeString('zh-CN')}）。`
        : '自动同步已开启。';
  }
}

export function SyncPanel({ importedFromLink = false, onClose, onSynced }: SyncPanelProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [lastResult, setLastResult] = useState('');
  const [autoState, setAutoState] = useState<AutoSyncState>(() => autoSync.getState());
  const [localCount, setLocalCount] = useState<number | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [revoked, setRevoked] = useState<RevokedDevice[]>([]);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [shareLink, setShareLink] = useState('');
  const [shareBase, setShareBase] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [blobFailures, setBlobFailures] = useState<BlobFailure[]>(() => listBlobFailures());
  const [weakNet, setWeakNet] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);

  const refreshLocalCount = useCallback(async () => {
    try {
      setLocalCount(await db.notes.count());
    } catch {
      setLocalCount(null);
    }
  }, []);

  useEffect(() => autoSync.subscribe(setAutoState), []);

  useEffect(() => subscribeBlobFailures(setBlobFailures), []);

  useEffect(() => {
    void loadPrefetchMode().then((mode) => setWeakNet(mode === 'off'));
  }, []);

  useEffect(() => {
    void refreshLocalCount();
  }, [refreshLocalCount, autoState.lastSuccessAt]);

  const configRef = useRef(config);
  configRef.current = config;
  const tokenReady = (config?.token ?? '').trim().length >= 16;
  const serverUrl = config?.serverUrl ?? '';
  useEffect(() => {
    if (!tokenReady) {
      setDevices([]);
      return;
    }
    let cancelled = false;
    // 输入地址时逐字符触发请求没有意义，等 400ms 静默再拉设备列表
    const timer = window.setTimeout(() => {
      void fetchDeviceRegistry({ ...(configRef.current as SyncConfig), serverUrl: serverUrl.trim() })
        .then((registry) => {
          if (cancelled) return;
          setDevices(registry.devices);
          setRevoked(registry.revoked);
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tokenReady, serverUrl, autoState.lastSuccessAt]);

  useEffect(() => {
    // 后台自动同步发现的冲突，打开面板时接着处理。
    if (autoState.conflicts.length > 0) setConflicts(autoState.conflicts);
  }, [autoState.conflicts]);

  useEffect(() => {
    loadSyncConfig()
      .then(setConfig)
      .catch((error: unknown) => setMessage(`读取同步配置失败：${String(error)}`));
  }, []);

  if (!config) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section
        ref={dialogRef}
        className="sync-panel"
        role="dialog"
        aria-modal="true"
        aria-label="多设备同步"
        tabIndex={-1}
      >
          <p>正在读取同步配置…</p>
        </section>
      </div>
    );
  }

  const update = (patch: Partial<SyncConfig>) => setConfig({ ...config, ...patch });

  const persist = async (next: SyncConfig) => {
    setConfig(next);
    await saveSyncConfig(next);
  };

  const runSync = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setConflicts([]);
    try {
      await persist({ ...config, serverUrl: config.serverUrl.trim() });
      const result = await autoSync.run(true);
      if (!result) {
        const current = autoSync.getState();
        setMessage(
          current.status === 'offline'
            ? '当前离线，恢复网络后会自动同步。'
            : current.status === 'syncing'
              ? '同步进行中，请稍候。'
              : '同步失败：' + String(current.lastError ?? '未配置服务器或 token')
        );
        return;
      }
      setConfig(await loadSyncConfig());
      setConflicts(result.conflicts);
      const summary = [`拉取 ${result.pulled}`, `推送 ${result.pushed}`];
      if (result.relationsPulled > 0 || result.relationsPushed > 0) {
        summary.push(`关系 ${result.relationsPulled}/${result.relationsPushed}`);
      }
      if (result.attachmentsPulled > 0 || result.attachmentsPushed > 0) {
        summary.push(`附件 ${result.attachmentsPulled}/${result.attachmentsPushed}`);
      }
      if (result.canvasPulled > 0 || result.canvasPushed > 0) {
        summary.push(`画布 ${result.canvasPulled}/${result.canvasPushed}`);
      }
      summary.push(`冲突 ${result.conflicts.length}`);
      setLastResult(summary.join('，'));
      setMessage(
        result.conflicts.length > 0
          ? '同步完成，但有冲突需要你选择。'
          : '同步完成。'
      );
      await onSynced();
    } catch (error: unknown) {
      setMessage(`同步失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const renderShare = async (base: string) => {
    const normalized = base.trim() || window.location.origin + '/';
    // 手机拿到的是它自己能访问的地址（隧道 origin），不是 PC 的 127.0.0.1:3000
    const link = buildSyncLink(normalized, { serverUrl: normalized, token: config.token });
    setShareLink(link);
    try {
      const { default: QRCode } = await import('qrcode');
      setQrDataUrl(await QRCode.toDataURL(link, { width: 240, margin: 1 }));
    } catch {
      setQrDataUrl('');
    }
  };

  const openShare = async () => {
    // 手机扫的是它自己能访问的地址：服务器地址不是回环时用它，否则用当前页面地址。
    const serverUrl = config.serverUrl.trim();
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(serverUrl);
    const base = serverUrl && !isLoopback ? serverUrl : window.location.origin + '/';
    setShareBase(base);
    await renderShare(base);
  };

  const resetCursor = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      // 游标被推进到较早数据之后时（换机/重装/中途失败），只能回到 1970 全量重拉。
      await persist({ ...config, lastSyncAt: null, revisions: {} });
      const result = await autoSync.run(true);
      if (!result) {
        setMessage('全量重同步失败：' + String(autoSync.getState().lastError ?? '未知错误'));
        return;
      }
      setConfig(await loadSyncConfig());
      setConflicts(result.conflicts);
      setLastResult(`全量重同步：拉取 ${result.pulled}，推送 ${result.pushed}，冲突 ${result.conflicts.length}`);
      setMessage('游标已重置，全量数据已拉取。');
      await onSynced();
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (conflict: SyncConflict, choice: SyncConflictChoice) => {
    if (busy) return;
    setBusy(true);
    try {
      const revisions = await resolveSyncConflict(conflict, choice, config);
      await persist({ ...config, revisions });
      autoSync.clearConflict(conflict.id);
      setConflicts((current) => current.filter((item) => item.id !== conflict.id));
      setMessage(
        choice === 'remote'
          ? '已使用远端内容；本地旧内容已写入版本历史。'
          : choice === 'local'
            ? '已保留本地内容并推送到服务器。'
            : '已生成冲突副本并推送到服务器。'
      );
      await onSynced();
    } catch (error: unknown) {
      setMessage(`处理冲突失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const refreshRegistry = async () => {
    try {
      const registry = await fetchDeviceRegistry({ ...config, serverUrl: config.serverUrl.trim() });
      setDevices(registry.devices);
      setRevoked(registry.revoked);
    } catch {
      /* 列表刷新失败不影响操作结果，下次打开面板会重拉 */
    }
  };

  // B-1：用当前（管理）token 为本机换取设备凭证，之后只保存设备 token。
  const useDeviceToken = async () => {
    if (tokenBusy || busy) return;
    setTokenBusy(true);
    setMessage('');
    try {
      const target = { ...config, serverUrl: config.serverUrl.trim(), token: config.token.trim() };
      if (!target.serverUrl || !target.token) {
        setMessage('先填写服务器地址和管理 token，再换取设备凭证');
        return;
      }
      const deviceToken = await issueDeviceToken(target);
      // 换票前先确认新凭证可用，避免把唯一可用的 token 覆盖掉。
      await saveSyncConfig({ ...target, token: deviceToken, deviceToken: true });
      setConfig(await loadSyncConfig());
      setMessage('已换取设备凭证：本机现在使用专属 token，管理 token 不再保存在这里。');
    } catch (error: unknown) {
      // 失败时保留原来的 token，设备不会被锁死。
      setMessage(`换取设备凭证失败：${String(error)}（原 token 未改动）`);
    } finally {
      setTokenBusy(false);
    }
  };

  const changeDevice = async (device: RemoteDevice | RevokedDevice, action: 'revoke' | 'restore') => {
    if (deviceBusy || busy) return;
    setDeviceBusy(true);
    setMessage('');
    const label = device.name || device.id;
    try {
      const target = { ...config, serverUrl: config.serverUrl.trim() };
      const ok =
        action === 'revoke' ? await revokeDevice(target, device.id) : await restoreDevice(target, device.id);
      if (!ok) {
        setMessage(`${action === 'revoke' ? '撤销' : '恢复'}「${label}」失败：服务器拒绝了请求。`);
        return;
      }
      setMessage(
        action === 'revoke'
          ? `已撤销「${label}」：该设备无法再同步（笔记与版本保留），可在「已撤销设备」里恢复。`
          : `已恢复「${label}」：该设备下次同步会重新注册。`
      );
      await refreshRegistry();
    } catch (error: unknown) {
      setMessage(`操作设备失败：${String(error)}`);
    } finally {
      setDeviceBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="sync-panel"
        data-testid="sync-panel"
        role="dialog"
        aria-modal="true"
        aria-label="多设备同步"
        tabIndex={-1}
      >
        <header className="version-header">
          <h2>多设备同步</h2>
          <button type="button" onClick={onClose} data-testid="close-sync">
            关闭
          </button>
        </header>

        <label className="sync-field">
          服务器地址
          <input
            data-testid="sync-server"
            value={config.serverUrl}
            onChange={(event) => update({ serverUrl: event.target.value })}
            placeholder="http://127.0.0.1:3000"
          />
        </label>
        <label className="sync-field">
          访问 token
          <input
            type="password"
            data-testid="sync-token"
            value={config.token}
            onChange={(event) => update({ token: event.target.value, deviceToken: false })}
            placeholder="服务器 Bearer token"
          />
        </label>
        <p className="sync-note" data-testid="sync-token-kind">
          {config.deviceToken
            ? '本机使用专属设备凭证（B-1）：吊销本机时该凭证立即失效。'
            : '当前使用管理 token：可同步、可管理设备；建议换成本机专属凭证。'}
        </p>
        {!config.deviceToken && config.token.trim() && (
          <div className="sync-actions">
            <button
              type="button"
              data-testid="sync-use-device-token"
              disabled={tokenBusy || busy}
              onClick={() => void useDeviceToken()}
            >
              {tokenBusy ? '换取中…' : '换取本机设备凭证'}
            </button>
            <span className="sync-note">
              换取后本机只保存专用 token；管理 token 请另存（用于其他设备签发与设备管理）。
            </span>
          </div>
        )}
        <label className="sync-field">
          设备名称
          <input
            data-testid="sync-device"
            value={config.deviceName}
            onChange={(event) => update({ deviceName: event.target.value })}
          />
        </label>

        {(localCount ?? 0) > 0 && (
          <p className="sync-note" data-testid="sync-reset-hint">
            本机已有 {localCount} 篇，「全量重同步」已禁用（空设备才需要它）。
          </p>
        )}

        <p className="sync-note" data-testid="sync-local">
          本机 IndexedDB：{localCount === null ? '读取失败' : `${localCount} 篇`} · 游标 since={' '}
          {config.lastSyncAt ?? '1970-01-01T00:00:00.000Z'}
        </p>

        {shareLink && (
          <div className="sync-qr" data-testid="sync-qr-panel">
            {qrDataUrl ? (
              <img data-testid="sync-qr" src={qrDataUrl} alt="同步配置二维码" width={180} height={180} />
            ) : (
              <p className="sync-note">二维码生成失败，可直接复制下面的链接。</p>
            )}
            <label className="sync-field">
              二维码里的地址（手机要能打开）
              <input
                data-testid="sync-share-base"
                value={shareBase}
                onChange={(event) => setShareBase(event.target.value)}
                placeholder="https://你的隧道地址"
              />
            </label>
            <button type="button" data-testid="sync-share-render" onClick={() => void renderShare(shareBase)}>
              重新生成
            </button>
            <p className="sync-note" data-testid="sync-link">
              {shareLink}
            </p>
            <button type="button" data-testid="sync-copy-link" onClick={() => void navigator.clipboard.writeText(shareLink)}>
              复制配置链接
            </button>
          </div>
        )}

        {blobFailures.length > 0 && (
          <p className="sync-note" data-testid="sync-blob-failures">
            附件下载失败 {blobFailures.length} 个（{blobFailures.map((row) => row.name).join('、')}）。
            {blobFailures.some((row) => row.nextRetryAt !== null)
              ? `已失败 ${Math.max(...blobFailures.map((row) => row.attempts))} 次，已安排自动重试。`
              : blobFailures.every((row) => row.exhausted)
                ? `自动重试已停止（已失败 ${Math.max(...blobFailures.map((row) => row.attempts))} 次），可手动重试。`
                : '可手动重试。'}
            <button type="button" data-testid="sync-blob-retry" onClick={() => requestBlobRetry()}>
              重试
            </button>
          </p>
        )}

        {importedFromLink && (
          <p className="sync-note" data-testid="sync-imported">
            已从扫码链接导入服务器地址与 token，可直接「立即同步」。
          </p>
        )}

        {(devices.length > 0 || revoked.length > 0) && (
          <div className="device-registry" data-testid="device-list">
            <h3>已注册设备 {devices.length}</h3>
            {devices.length === 0 ? (
              <p className="sync-note">暂无在线注册设备。</p>
            ) : (
              <ul className="device-rows">
                {devices.map((device) => {
                  const isSelf = device.id === config.deviceId;
                  return (
                    <li className="device-row" data-testid="device-row" key={device.id}>
                      <span className="device-name">
                        {device.name || '未命名设备'}
                        {isSelf ? '（本机）' : ''}
                      </span>
                      <span className="device-meta">最近活跃 {formatTime(device.lastSeen)}</span>
                      <button
                        type="button"
                        data-testid="device-revoke"
                        disabled={deviceBusy || isSelf}
                        title={
                          isSelf
                            ? '不能撤销本机；请在其他设备上操作'
                            : '撤销后该设备无法再同步（笔记保留），可在下方恢复'
                        }
                        onClick={() => void changeDevice(device, 'revoke')}
                      >
                        撤销
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {revoked.length > 0 && (
              <div className="device-revoked" data-testid="revoked-list">
                <h4>已撤销设备 {revoked.length}</h4>
                <ul className="device-rows">
                  {revoked.map((device) => (
                    <li className="device-row" data-testid="revoked-row" key={device.id}>
                      <span className="device-name">{device.name || device.id}</span>
                      <span className="device-meta">撤销于 {formatTime(device.revokedAt)}</span>
                      <button
                        type="button"
                        data-testid="device-restore"
                        disabled={deviceBusy}
                        onClick={() => void changeDevice(device, 'restore')}
                      >
                        恢复
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <label className="sync-note sync-check" data-testid="sync-weak-net-row">
          <input
            type="checkbox"
            data-testid="sync-weak-net"
            checked={weakNet}
            onChange={(event) => {
              const off = event.target.checked;
              setWeakNet(off);
              void savePrefetchMode(off ? 'off' : 'auto');
            }}
          />
          弱网模式：打开笔记时不自动预取附件（仍可手动下载）
        </label>

        <p className="sync-note" data-testid="sync-auto">
          {autoLabel(autoState, config.token)}
        </p>

        <div className="sync-actions">
          <button type="button" className="primary" data-testid="sync-now" disabled={busy} onClick={() => void runSync()}>
            {busy ? '同步中…' : '立即同步'}
          </button>
          <button type="button" data-testid="sync-config-save" onClick={() => void persist(config)}>
            保存配置
          </button>
          <button type="button" data-testid="sync-share" onClick={() => void openShare()}>
            配置二维码
          </button>
          <button
            type="button"
            data-testid="sync-reset"
            onClick={() => void resetCursor()}
            disabled={busy || (localCount ?? 0) > 0}
            title={
              (localCount ?? 0) > 0
                ? '本机已有笔记时不能重置游标：每篇都会被判成冲突并回推旧内容。只在空设备上使用。'
                : '清空游标并重新拉取服务端全部数据'
            }
          >
            全量重同步
          </button>
          <span data-testid="sync-last">上次同步：{formatTime(config.lastSyncAt)}</span>
        </div>

        <p className="sync-note">
          token 会保存在本地 IndexedDB；只连接你自己的服务器。同步覆盖笔记、手动关系与附件元数据（附件文件本身暂不同步）。
        </p>
        {lastResult && <p data-testid="sync-result">{lastResult}</p>}
        {message && <p data-testid="sync-message">{message}</p>}

        {conflicts.length > 0 && (
          <div className="sync-conflicts" data-testid="sync-conflicts">
            <h3>冲突 {conflicts.length}</h3>
            {conflicts.map((conflict) => (
              <div className="sync-conflict" data-testid="sync-conflict" key={conflict.id}>
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
                  <button type="button" data-testid="sync-keep-local" onClick={() => void resolve(conflict, 'local')}>
                    保留本地
                  </button>
                  <button type="button" data-testid="sync-use-remote" onClick={() => void resolve(conflict, 'remote')}>
                    使用远端
                  </button>
                  <button type="button" data-testid="sync-conflict-copy" onClick={() => void resolve(conflict, 'copy')}>
                    生成冲突副本
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

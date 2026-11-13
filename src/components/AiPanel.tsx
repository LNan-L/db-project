/**
 * @req REQ-205 / REQ-301 — Phase 5.0.1：AI 设置面板（chat / embedding 两端点）。
 *
 * chat 与 embedding 分开配置、分开授权、分开测试连接（主库：DeepSeek + 硅基流动）。
 * 远端授权绑定 origin；改地址立即失效；loopback 端点不需要授权。
 */
import { useEffect, useState } from 'react';
import { useDialogA11y } from '../lib/useDialogA11y';
import {
  baseUrlOrigin,
  describeRemoteSend,
  endpointBlockedReason,
  isLoopbackBaseUrl,
  isValidBaseUrl,
  loadAiSettings,
  normalizeAiSettings,
  saveAiSettings,
  type AiEndpoint,
  type AiSettings
} from '../ai/settings';
import { createChatProvider, createEmbeddingProvider } from '../ai/provider';
import type { Note } from '../domain/note';
import { clearEmbeddings } from '../storage/embeddings';
import {
  getVectorIndexStatus,
  rebuildVectorIndex,
  type VectorIndexStatus
} from '../search/vectorIndex';

interface AiPanelProps {
  notes: Note[];
  onClose: () => void;
}

type EndpointKey = 'chat' | 'embedding';

function displayOrigin(baseUrl: string): string {
  return baseUrlOrigin(baseUrl) ?? baseUrl;
}

export function AiPanel({ notes, onClose }: AiPanelProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState<EndpointKey | null>(null);
  const [pendingConsent, setPendingConsent] = useState<EndpointKey | null>(null);
  const [pendingRebuild, setPendingRebuild] = useState<{ origin: string; characters: number } | null>(
    null
  );
  const [vectorStatus, setVectorStatus] = useState<VectorIndexStatus | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [vectorProgress, setVectorProgress] = useState('');

  useEffect(() => {
    let cancelled = false;
    loadAiSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    void getVectorIndexStatus(notes, settings)
      .then(setVectorStatus)
      .catch(() => setVectorStatus(null));
  }, [notes, settings?.embedding.model]);

  if (loadError) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section
          ref={dialogRef}
          className="sync-panel"
          data-testid="ai-panel-error"
          role="alertdialog"
          aria-modal="true"
          aria-label="AI 设置"
          tabIndex={-1}
        >
          <header className="version-header">
            <h2>AI 设置</h2>
            <button type="button" data-testid="close-ai" onClick={onClose}>
              关闭
            </button>
          </header>
          <p className="sync-note">读取 AI 设置失败：{loadError}</p>
          <p className="sync-note">可以先关闭面板，笔记数据不受影响。</p>
        </section>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section
          ref={dialogRef}
          className="sync-panel"
          role="dialog"
          aria-modal="true"
          aria-label="AI 设置"
          tabIndex={-1}
        >
          <header className="version-header">
            <h2>AI 设置</h2>
            <button type="button" data-testid="close-ai" onClick={onClose}>
              关闭
            </button>
          </header>
          <p>正在读取 AI 设置…</p>
        </section>
      </div>
    );
  }

  const update = (patch: Partial<AiSettings>) => {
    setSettings({ ...settings, ...patch });
    setMessage('');
  };

  const updateEndpoint = (key: EndpointKey, patch: Partial<AiEndpoint>) => {
    setSettings((current) => {
      if (!current) return current;
      let next: AiEndpoint = { ...current[key], ...patch };
      if (patch.baseUrl !== undefined) {
        const origin = baseUrlOrigin(patch.baseUrl);
        if (next.remoteConsentBaseUrl && (origin === null || origin !== next.remoteConsentBaseUrl)) {
          next = {
            ...next,
            remoteAllowed: false,
            remoteConsentAt: null,
            remoteConsentBaseUrl: null
          };
        }
      }
      return { ...current, [key]: next };
    });
    setMessage('');
  };

  const approveConsent = (key: EndpointKey) => {
    const origin = baseUrlOrigin(settings[key].baseUrl);
    if (!origin) {
      setMessage('先填写有效的服务地址，再授权远端');
      return;
    }
    updateEndpoint(key, {
      remoteAllowed: true,
      remoteConsentAt: new Date().toISOString(),
      remoteConsentBaseUrl: origin
    });
    setPendingConsent(null);
    setMessage(`已授权${key === 'chat' ? '对话' : '嵌入'}请求发到 ${origin}`);
  };

  const validateEndpoint = (key: EndpointKey): string | null => {
    const endpoint = settings[key];
    if (!isValidBaseUrl(endpoint.baseUrl)) return `${key === 'chat' ? '对话' : '嵌入'}服务地址无效`;
    if (!endpoint.model.trim()) return `${key === 'chat' ? '对话' : '嵌入'}模型不能为空`;
    return endpointBlockedReason(endpoint);
  };

  const save = async () => {
    // 保存只校验结构（地址/模型）；远端授权只影响「使用」，不应阻止保存配置。
    for (const key of ['chat', 'embedding'] as EndpointKey[]) {
      const endpoint = settings[key];
      if (!isValidBaseUrl(endpoint.baseUrl)) {
        setMessage(`${key === 'chat' ? '对话' : '嵌入'}服务地址无效：请填写 http(s) 地址`);
        return;
      }
      if (!endpoint.model.trim()) {
        setMessage(`${key === 'chat' ? '对话' : '嵌入'}模型不能为空`);
        return;
      }
    }
    const normalized = normalizeAiSettings(
      settings as unknown as Partial<AiSettings> & Record<string, unknown>
    );
    try {
      await saveAiSettings(normalized);
      setSettings(normalized);
      const pending = (['chat', 'embedding'] as EndpointKey[]).filter(
        (key) => endpointBlockedReason(normalized[key]) !== null
      );
      setMessage(
        pending.length > 0
          ? 'AI 设置已保存；远端端点仍需授权后才能使用'
          : 'AI 设置已保存'
      );
    } catch (error: unknown) {
      setMessage(`保存失败：${String(error)}`);
    }
  };

  const testConnection = async (key: EndpointKey) => {
    const error = validateEndpoint(key);
    if (error) {
      setMessage(error);
      return;
    }
    setTesting(key);
    setMessage('');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    try {
      const provider =
        key === 'chat' ? createChatProvider(settings) : createEmbeddingProvider(settings);
      const healthy = await provider.health(controller.signal);
      const label = key === 'chat' ? '对话' : '嵌入';
      if (controller.signal.aborted) {
        setMessage(`${label}连接超时（8 秒）`);
      } else {
        setMessage(
          `${label}${healthy ? '连接成功' : '连接失败'}：${displayOrigin(settings[key].baseUrl)}`
        );
      }
    } catch (error: unknown) {
      setMessage(`连接失败：${String(error)}`);
    } finally {
      window.clearTimeout(timer);
      setTesting(null);
    }
  };

  const runRebuild = async (normalized: AiSettings) => {
    setPendingRebuild(null);
    setRebuilding(true);
    setVectorProgress('');
    setMessage('');
    try {
      await saveAiSettings(normalized);
      setSettings(normalized);
      const provider = createEmbeddingProvider(normalized);
      const stats = await rebuildVectorIndex(notes, normalized, {
        provider,
        maxNotes: notes.length,
        onProgress: (done, total) => setVectorProgress(`${done}/${total}`)
      });
      setVectorStatus(await getVectorIndexStatus(notes, normalized).catch(() => null));
      if (stats.aborted) {
        setMessage('索引重建已取消（已建立的索引保留）');
      } else if (stats.failed > 0) {
        setMessage(
          `索引部分完成：成功 ${stats.indexed} 篇，失败 ${stats.failed} 篇，剩余 ${stats.remaining} 篇未处理；旧索引保留${stats.lastError ? `。首个错误：${stats.lastError.slice(0, 180)}` : ''}`
        );
      } else {
        setMessage(`索引完成：${stats.indexed} 篇 / ${stats.chunks} 个分块`);
      }
    } catch (error: unknown) {
      setMessage(`重建索引失败：${String(error)}（旧索引未删除）`);
    } finally {
      setRebuilding(false);
      setVectorProgress('');
    }
  };

  const rebuildIndex = async () => {
    if (rebuilding) return;
    if (!settings.enabled) {
      setMessage('先启用 AI 功能，再重建索引');
      return;
    }
    const embeddingError = validateEndpoint('embedding');
    if (embeddingError) {
      setMessage(embeddingError);
      return;
    }
    if (!isLoopbackBaseUrl(settings.embedding.baseUrl) && !settings.embedding.apiKey.trim()) {
      setMessage('嵌入端点缺少 API key：请先填写并保存，再重建索引');
      return;
    }
    const normalized = normalizeAiSettings(
      settings as unknown as Partial<AiSettings> & Record<string, unknown>
    );
    if (!isLoopbackBaseUrl(normalized.embedding.baseUrl)) {
      const characters = notes.reduce((sum, note) => sum + note.title.length + note.body.length, 0);
      // 内联确认，不用浏览器原生 confirm（可能被拦或看不见）。
      setPendingRebuild({
        origin: baseUrlOrigin(normalized.embedding.baseUrl) ?? normalized.embedding.baseUrl,
        characters
      });
      return;
    }
    await runRebuild(normalized);
  };

  const clearIndex = async () => {
    if (!window.confirm('清空当前向量索引？关闭语义检索时不会自动重建。')) return;
    try {
      await clearEmbeddings();
      setVectorStatus(await getVectorIndexStatus(notes, settings).catch(() => null));
      setMessage('向量索引已清空');
    } catch (error: unknown) {
      setMessage(`清空索引失败：${String(error)}`);
    }
  };

  const renderEndpoint = (
    key: EndpointKey,
    title: string,
    prefix: string,
    placeholderUrl: string,
    placeholderModel: string
  ) => {
    const endpoint = settings[key];
    const blocked = endpointBlockedReason(endpoint);
    const label = key === 'chat' ? '对话' : '嵌入';
    return (
      <section className="ai-endpoint" data-testid={`ai-${prefix}-section`}>
        <h3>{title}</h3>
        <label className="sync-field">
          服务地址（OpenAI 兼容，必须是 http(s)）
          <input
            data-testid={`ai-${prefix}-base-url`}
            value={endpoint.baseUrl}
            onChange={(event) => updateEndpoint(key, { baseUrl: event.target.value })}
            placeholder={placeholderUrl}
          />
        </label>
        <label className="sync-field">
          模型
          <input
            data-testid={`ai-${prefix}-model`}
            value={endpoint.model}
            onChange={(event) => updateEndpoint(key, { model: event.target.value })}
            placeholder={placeholderModel}
          />
        </label>
        <div className="sync-field">
          <span>API Key（只存本机；本机 loopback 地址不会携带）</span>
          <input
            type="password"
            data-testid={`ai-${prefix}-key`}
            value={endpoint.apiKey}
            onChange={(event) => updateEndpoint(key, { apiKey: event.target.value })}
            placeholder={`${label}服务的 key`}
          />
          {endpoint.apiKey && (
            <button
              type="button"
              data-testid={`ai-${prefix}-clear-key`}
              onClick={() => updateEndpoint(key, { apiKey: '' })}
            >
              清除 key
            </button>
          )}
        </div>
        <label className="sync-note sync-check">
          <input
            type="checkbox"
            data-testid={`ai-${prefix}-remote`}
            checked={endpoint.remoteAllowed}
            onChange={(event) => {
              if (!event.target.checked) {
                setPendingConsent(null);
                updateEndpoint(key, {
                  remoteAllowed: false,
                  remoteConsentAt: null,
                  remoteConsentBaseUrl: null
                });
                return;
              }
              if (!isValidBaseUrl(endpoint.baseUrl)) {
                setMessage('先填写有效的服务地址，再授权远端');
                return;
              }
              if (isLoopbackBaseUrl(endpoint.baseUrl)) {
                setMessage('当前是本机地址，不需要远端授权');
                return;
              }
              setPendingConsent(key);
            }}
          />
          允许{label}请求发到远端（默认关闭，按地址授权）
        </label>
        {pendingConsent === key && (
          <div className="sync-actions" data-testid={`ai-${prefix}-consent-prompt`}>
            <span className="sync-note">
              确认把{label}请求发送到 {baseUrlOrigin(endpoint.baseUrl)}？
            </span>
            <button
              type="button"
              className="primary"
              data-testid={`ai-${prefix}-consent-confirm`}
              onClick={() => approveConsent(key)}
            >
              允许
            </button>
            <button
              type="button"
              data-testid={`ai-${prefix}-consent-cancel`}
              onClick={() => {
                setPendingConsent(null);
                setMessage('已取消授权');
              }}
            >
              取消
            </button>
          </div>
        )}
        {endpoint.remoteConsentAt && endpoint.remoteConsentBaseUrl && (
          <p className="sync-note" data-testid={`ai-${prefix}-consent`}>
            已授权 {endpoint.remoteConsentBaseUrl}（
            {new Date(endpoint.remoteConsentAt).toLocaleString('zh-CN')}）
          </p>
        )}
        {blocked && (
          <p className="sync-note" data-testid={`ai-${prefix}-blocked`}>
            {blocked}
          </p>
        )}
        <div className="sync-actions">
          <button
            type="button"
            data-testid={`ai-test-${prefix}`}
            disabled={testing !== null}
            onClick={() => void testConnection(key)}
          >
            {testing === key ? '测试中…' : `测试${label}连接`}
          </button>
        </div>
      </section>
    );
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="sync-panel"
        data-testid="ai-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI 设置"
        tabIndex={-1}
      >
        <header className="version-header">
          <h2>AI 设置</h2>
          <button type="button" data-testid="close-ai" onClick={onClose}>
            关闭
          </button>
        </header>

        <label className="sync-note sync-check" data-testid="ai-enabled-row">
          <input
            type="checkbox"
            data-testid="ai-enabled"
            checked={settings.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          启用 AI 功能（关闭时编辑/检索不会自动调用；测试连接仍可用）
        </label>

        {renderEndpoint(
          'chat',
          '对话端点（chat）',
          'chat',
          'https://api.deepseek.com/v1',
          'deepseek-chat'
        )}
        {renderEndpoint(
          'embedding',
          '嵌入端点（embedding，用于语义检索）',
          'embedding',
          'https://api.siliconflow.cn/v1',
          'BAAI/bge-m3'
        )}

        <section className="ai-endpoint">
          <h3>语义检索</h3>
          <label className="sync-note sync-check">
            <input
              type="checkbox"
              data-testid="ai-vector"
              checked={settings.vectorSearchEnabled}
              onChange={(event) => update({ vectorSearchEnabled: event.target.checked })}
            />
            启用语义检索（REQ-301；关闭时只用全文 BM25）
          </label>
          {!settings.enabled && (
            <p className="sync-note" data-testid="ai-vector-needs-enabled">
              先勾选上方「启用 AI 功能」并保存，才能重建索引或使用语义检索。
            </p>
          )}
          <div className="sync-actions">
            <button
              type="button"
              data-testid="ai-rebuild-vector"
              disabled={rebuilding || !settings.enabled}
              title={settings.enabled ? '逐篇覆盖索引，失败时旧索引保留' : '先启用 AI 功能'}
              onClick={() => void rebuildIndex()}
            >
              {rebuilding ? `重建中… ${vectorProgress}` : '重建向量索引'}
            </button>
            <button type="button" data-testid="ai-clear-vector" onClick={() => void clearIndex()}>
              清空索引
            </button>
            <span className="sync-note" data-testid="ai-vector-status">
              已索引 {vectorStatus?.indexed ?? '未知'}/{vectorStatus?.total ?? '未知'} 篇
              {vectorStatus && vectorStatus.stale > 0 ? `，${vectorStatus.stale} 篇待更新` : ''}
              （模型 {settings.embedding.model}）
            </span>
          </div>
          {pendingRebuild && (
            <div className="sync-actions" data-testid="ai-rebuild-prompt">
              <span className="sync-note">
                {describeRemoteSend(notes.length, pendingRebuild.characters)}目标：
                {pendingRebuild.origin}。确认继续？
              </span>
              <button
                type="button"
                className="primary"
                data-testid="ai-rebuild-confirm"
                onClick={() =>
                  void runRebuild(
                    normalizeAiSettings(
                      settings as unknown as Partial<AiSettings> & Record<string, unknown>
                    )
                  )
                }
              >
                继续重建
              </button>
              <button
                type="button"
                data-testid="ai-rebuild-cancel"
                onClick={() => setPendingRebuild(null)}
              >
                取消
              </button>
            </div>
          )}
        </section>

        <p className="sync-note">
          所有 key 只保存在本机 IndexedDB；远端端点需逐个授权，草稿与索引重建前还会再次确认。
        </p>

        <div className="sync-actions">
          <button type="button" data-testid="ai-save" onClick={() => void save()}>
            保存设置
          </button>
          <span data-testid="ai-message">{message}</span>
        </div>
      </section>
    </div>
  );
}

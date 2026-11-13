/**
 * @req REQ-205 / REQ-301 — Phase 5.0.1：AI 设置拆分为 chat / embedding 两套端点。
 *
 * 背景（2026-11-12）：主库 chat 用 DeepSeek、embedding 用硅基流动 BAAI/bge-m3，
 * 两家供应商、两把 key，因此设置、授权、连通性检查都按端点独立管理。
 *
 * 隐私约束保持不变：
 * - 是否「远端」按 baseUrl 目的地判断，不看任何标签；
 * - 每个远端端点单独授权（时间 + 绑定 origin），地址变化即失效；
 * - 非法时间戳/缺 origin 视为未授权（fail-closed）；
 * - 保存保留未知字段；旧版单端点设置自动迁移到两个端点。
 */
import { db, type PkeDatabase } from '../storage/db';
import { getMetaValue, setMetaValue } from '../storage/meta';

export const AI_SETTINGS_KEY = 'ai_settings';

export interface AiEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 该端点是否允许把内容发到远端（默认 false）。 */
  remoteAllowed: boolean;
  remoteConsentAt: string | null;
  /** 授权绑定的 origin；地址变化后需要重新授权。 */
  remoteConsentBaseUrl: string | null;
}

export interface AiSettings {
  enabled: boolean;
  chat: AiEndpoint;
  embedding: AiEndpoint;
  /** REQ-301 的向量检索开关；关闭时只用 BM25。 */
  vectorSearchEnabled: boolean;
}

export const DEFAULT_CHAT_ENDPOINT: AiEndpoint = {
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  remoteAllowed: false,
  remoteConsentAt: null,
  remoteConsentBaseUrl: null
};

export const DEFAULT_EMBEDDING_ENDPOINT: AiEndpoint = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  apiKey: '',
  remoteAllowed: false,
  remoteConsentAt: null,
  remoteConsentBaseUrl: null
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  chat: { ...DEFAULT_CHAT_ENDPOINT },
  embedding: { ...DEFAULT_EMBEDDING_ENDPOINT },
  vectorSearchEnabled: false
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function validTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function parseUrl(value: string): URL | null {
  try {
    // 必须是绝对 URL；相对地址（如 `abc`）会被拒绝，避免打到应用自身。
    return new URL(value);
  } catch {
    return null;
  }
}

export function baseUrlOrigin(value: string): string | null {
  return parseUrl(value)?.origin ?? null;
}

export function isValidBaseUrl(value: string): boolean {
  const url = parseUrl(value);
  return Boolean(url && (url.protocol === 'http:' || url.protocol === 'https:'));
}

export function isLoopbackBaseUrl(value: string): boolean {
  const url = parseUrl(value);
  if (!url) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function isRemoteDestination(endpoint: Pick<AiEndpoint, 'baseUrl'>): boolean {
  return !isLoopbackBaseUrl(endpoint.baseUrl);
}

function normalizeEndpoint(
  parsed: Partial<AiEndpoint>,
  defaults: AiEndpoint
): AiEndpoint {
  const baseUrl = text(parsed.baseUrl, defaults.baseUrl);
  const model = text(parsed.model, defaults.model);
  const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
  const origin = baseUrlOrigin(baseUrl);
  const consentAt = validTimestamp(parsed.remoteConsentAt);
  const consentBase =
    typeof parsed.remoteConsentBaseUrl === 'string' && parsed.remoteConsentBaseUrl.trim()
      ? parsed.remoteConsentBaseUrl.trim()
      : null;
  // 授权必须成对存在，且绑定到当前地址；否则视为未授权。
  const allowed =
    parsed.remoteAllowed === true &&
    consentAt !== null &&
    consentBase !== null &&
    origin !== null &&
    consentBase === origin;
  return {
    baseUrl,
    model,
    apiKey,
    remoteAllowed: allowed,
    remoteConsentAt: allowed ? consentAt : null,
    remoteConsentBaseUrl: allowed ? consentBase : null
  };
}

export function normalizeAiSettings(parsed: Partial<AiSettings> & Record<string, unknown>): AiSettings {
  const hasEndpoints = Boolean(parsed.chat || parsed.embedding);
  if (hasEndpoints) {
    return {
      enabled: parsed.enabled === true,
      chat: normalizeEndpoint((parsed.chat ?? {}) as Partial<AiEndpoint>, DEFAULT_CHAT_ENDPOINT),
      embedding: normalizeEndpoint(
        (parsed.embedding ?? {}) as Partial<AiEndpoint>,
        DEFAULT_EMBEDDING_ENDPOINT
      ),
      vectorSearchEnabled: parsed.vectorSearchEnabled === true
    };
  }
  // 旧版单端点设置迁移：同一 baseUrl/key 拆到两个端点，模型各取各的。
  const legacy = parsed as unknown as {
    baseUrl?: unknown;
    model?: unknown;
    embeddingModel?: unknown;
    apiKey?: unknown;
    remoteAllowed?: unknown;
    remoteConsentAt?: unknown;
    remoteConsentBaseUrl?: unknown;
  };
  const baseUrl = text(legacy.baseUrl, DEFAULT_CHAT_ENDPOINT.baseUrl);
  const origin = baseUrlOrigin(baseUrl);
  const consentAt = validTimestamp(legacy.remoteConsentAt);
  const consentBase =
    typeof legacy.remoteConsentBaseUrl === 'string' ? legacy.remoteConsentBaseUrl.trim() : null;
  const legacyConsent = {
    remoteAllowed: legacy.remoteAllowed === true,
    remoteConsentAt: consentAt,
    remoteConsentBaseUrl: consentBase !== null && consentBase === origin ? consentBase : null
  };
  return {
    enabled: parsed.enabled === true,
    chat: normalizeEndpoint(
      { baseUrl, model: text(legacy.model, ''), apiKey: String(legacy.apiKey ?? ''), ...legacyConsent },
      DEFAULT_CHAT_ENDPOINT
    ),
    embedding: normalizeEndpoint(
      {
        baseUrl,
        model: text(legacy.embeddingModel, ''),
        apiKey: String(legacy.apiKey ?? ''),
        ...legacyConsent
      },
      DEFAULT_EMBEDDING_ENDPOINT
    ),
    vectorSearchEnabled: parsed.vectorSearchEnabled === true
  };
}

export async function loadAiSettings(database: PkeDatabase = db): Promise<AiSettings> {
  const raw = await getMetaValue(AI_SETTINGS_KEY, database);
  if (!raw) return structuredCloneSettings(DEFAULT_AI_SETTINGS);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return structuredCloneSettings(DEFAULT_AI_SETTINGS);
    }
    return normalizeAiSettings(parsed as Partial<AiSettings> & Record<string, unknown>);
  } catch {
    return structuredCloneSettings(DEFAULT_AI_SETTINGS);
  }
}

function structuredCloneSettings(settings: AiSettings): AiSettings {
  return {
    enabled: settings.enabled,
    chat: { ...settings.chat },
    embedding: { ...settings.embedding },
    vectorSearchEnabled: settings.vectorSearchEnabled
  };
}

export async function saveAiSettings(
  settings: AiSettings,
  database: PkeDatabase = db
): Promise<void> {
  const normalized = normalizeAiSettings(
    settings as unknown as Partial<AiSettings> & Record<string, unknown>
  );
  // 保留未知字段：新版本写入的字段不会被旧版本回写抹掉。
  let extras: Record<string, unknown> = {};
  const raw = await getMetaValue(AI_SETTINGS_KEY, database);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extras = parsed as Record<string, unknown>;
      }
    } catch {
      extras = {};
    }
  }
  await setMetaValue(AI_SETTINGS_KEY, JSON.stringify({ ...extras, ...normalized }), database);
}

/** 单个端点不可用时的原因；loopback 或在该 origin 已授权时返回 null。 */
export function endpointBlockedReason(endpoint: AiEndpoint): string | null {
  if (!isValidBaseUrl(endpoint.baseUrl)) return '服务地址无效：请填写 http(s) 地址';
  if (!isRemoteDestination(endpoint)) return null;
  const origin = baseUrlOrigin(endpoint.baseUrl);
  if (!origin) return '服务地址无效：请填写 http(s) 地址';
  if (endpoint.remoteConsentAt === null || endpoint.remoteConsentBaseUrl === null) {
    return '远端服务未获授权：请先允许发送内容';
  }
  if (endpoint.remoteConsentBaseUrl !== origin) {
    return `远端地址已变更为 ${origin}，请重新授权`;
  }
  return null;
}

/** 发送前给用户看的摘要（草稿/远端重建前二次确认用）。 */
export function describeRemoteSend(noteCount: number, characters: number): string {
  return `将把 ${noteCount} 篇笔记（约 ${characters} 字符）发送到远端 AI 服务。`;
}

/**
 * @req REQ-205 / REQ-301 — Phase 5.0：AI provider 抽象。
 *
 * 只实现 OpenAI 兼容协议（/models、/embeddings、/chat/completions），
 * 本地 Ollama 与用户自配的远端端点共用一套实现；测试通过注入 fetch 完成。
 *
 * 评审后修正：createProvider 在内部强制执行远端授权（不再依赖调用方记得检查），
 * 且 loopback 地址不会携带 API key；错误信息附带服务端返回的简短原因。
 */
import type { AiEndpoint, AiSettings } from './settings';
import { endpointBlockedReason, isLoopbackBaseUrl } from './settings';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  signal?: AbortSignal;
}

export interface AiProvider {
  id: string;
  kind: 'local' | 'remote';
  health(signal?: AbortSignal): Promise<boolean>;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export interface ProviderConfig {
  kind: 'local' | 'remote';
  baseUrl: string;
  model: string;
  embeddingModel: string;
  apiKey?: string;
}

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function headers(apiKey?: string): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) result.Authorization = `Bearer ${apiKey}`;
  return result;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = (await response.json()) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new Error('AI 服务返回了非 JSON 内容');
  }
}

/** 非 2xx 时带出服务端返回的简短原因（不读请求头，避免泄露 key）。 */
async function httpFailure(prefix: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof body.error === 'string') detail = body.error;
    else if (body.error && typeof body.error.message === 'string') detail = body.error.message;
    else if (typeof body.message === 'string') detail = body.message;
  } catch {
    /* 非 JSON 错误体，忽略 */
  }
  detail = detail.trim().slice(0, 200);
  return new Error(`${prefix} ${response.status}${detail ? `：${detail}` : ''}`);
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly kind: 'local' | 'remote';
  private readonly config: ProviderConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: ProviderConfig, fetchImpl: FetchLike = fetch) {
    this.config = config;
    this.kind = config.kind;
    this.id = `openai-compatible:${config.kind}:${config.model}`;
    // 原生 fetch 必须作为函数调用；存成实例字段后直接调用会触发 Illegal invocation。
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      // 健康检查是 GET，不要带 Content-Type（避免不必要的 CORS 预检）。
      const requestHeaders: Record<string, string> = {};
      if (this.config.apiKey) requestHeaders.Authorization = `Bearer ${this.config.apiKey}`;
      const response = await this.fetchImpl(endpoint(this.config.baseUrl, '/models'), {
        headers: requestHeaders,
        signal
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(endpoint(this.config.baseUrl, '/embeddings'), {
      method: 'POST',
      headers: headers(this.config.apiKey),
      signal,
      body: JSON.stringify({ model: this.config.embeddingModel, input: texts })
    });
    if (!response.ok) throw await httpFailure('嵌入服务返回', response);
    const body = await readJson(response);
    const rows = Array.isArray(body.data) ? body.data : null;
    if (!rows || rows.length !== texts.length) throw new Error('嵌入服务返回格式不正确');
    const vectors: number[][] = [];
    for (const row of rows) {
      const embedding = (row as { embedding?: unknown })?.embedding;
      if (
        !Array.isArray(embedding) ||
        embedding.length === 0 ||
        !embedding.every((value) => typeof value === 'number' && Number.isFinite(value))
      ) {
        throw new Error('嵌入服务返回格式不正确');
      }
      vectors.push(embedding as number[]);
    }
    const dimension = vectors[0].length;
    if (vectors.some((vector) => vector.length !== dimension)) {
      throw new Error('嵌入服务返回的向量维度不一致');
    }
    return vectors;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const response = await this.fetchImpl(endpoint(this.config.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: headers(this.config.apiKey),
      signal: options.signal,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: false
      })
    });
    if (!response.ok) throw await httpFailure('对话服务返回', response);
    const body = await readJson(response);
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message
      ?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('对话服务没有返回内容');
    }
    return content;
  }
}

function buildProvider(
  endpoint: AiEndpoint,
  role: string,
  fetchImpl: FetchLike
): AiProvider {
  // 远端授权在这里强制检查（fail-closed）；loopback 不携带 key。
  const blocked = endpointBlockedReason(endpoint);
  if (blocked) throw new Error(`${role}：${blocked}`);
  const kind = isLoopbackBaseUrl(endpoint.baseUrl) ? 'local' : 'remote';
  return new OpenAiCompatibleProvider(
    {
      kind,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      embeddingModel: endpoint.model,
      apiKey: kind === 'local' ? undefined : endpoint.apiKey || undefined
    },
    fetchImpl
  );
}

/** 对话端点（DeepSeek 等）。 */
export function createChatProvider(
  settings: AiSettings,
  fetchImpl: FetchLike = fetch
): AiProvider {
  return buildProvider(settings.chat, '对话服务', fetchImpl);
}

/** 嵌入端点（硅基流动 BAAI/bge-m3 等）。 */
export function createEmbeddingProvider(
  settings: AiSettings,
  fetchImpl: FetchLike = fetch
): AiProvider {
  return buildProvider(settings.embedding, '嵌入服务', fetchImpl);
}

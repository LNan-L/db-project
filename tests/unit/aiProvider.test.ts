import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  type AiEndpoint,
  type AiSettings
} from '../../src/ai/settings';
import {
  createChatProvider,
  createEmbeddingProvider,
  OpenAiCompatibleProvider,
  type FetchLike
} from '../../src/ai/provider';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const config = {
  kind: 'local' as const,
  baseUrl: 'http://127.0.0.1:11434/v1/',
  model: 'qwen2.5:7b',
  embeddingModel: 'nomic-embed-text'
};

function localEndpoint(model: string, patch: Partial<AiEndpoint> = {}): AiEndpoint {
  return {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model,
    apiKey: '',
    remoteAllowed: false,
    remoteConsentAt: null,
    remoteConsentBaseUrl: null,
    ...patch
  };
}

function remoteEndpoint(
  baseUrl: string,
  model: string,
  patch: Partial<AiEndpoint> = {}
): AiEndpoint {
  return {
    baseUrl,
    model,
    apiKey: 'secret',
    remoteAllowed: true,
    remoteConsentAt: '2026-11-12T10:00:00.000Z',
    remoteConsentBaseUrl: new URL(baseUrl).origin,
    ...patch
  };
}

function settings(chat: AiEndpoint, embedding: AiEndpoint): AiSettings {
  return { enabled: true, chat, embedding, vectorSearchEnabled: true };
}

describe('OpenAI-compatible provider', () => {
  it('health is a clean GET /models, tolerates failure and passes the abort signal', async () => {
    const okFetch = vi.fn(async () => json({ data: [] })) as unknown as FetchLike;
    const provider = new OpenAiCompatibleProvider(config, okFetch);
    const controller = new AbortController();
    expect(await provider.health(controller.signal)).toBe(true);
    const [url, init] = (okFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/v1/models');
    expect(init.headers).toEqual({});
    expect(init.signal).toBe(controller.signal);

    const badFetch = vi.fn(async () => json({}, 500)) as unknown as FetchLike;
    expect(await new OpenAiCompatibleProvider(config, badFetch).health()).toBe(false);

    const brokenFetch = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as FetchLike;
    expect(await new OpenAiCompatibleProvider(config, brokenFetch).health()).toBe(false);
  });

  it('embeds through /embeddings with model, input, key and signal', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] })
    ) as unknown as FetchLike;
    const provider = new OpenAiCompatibleProvider(
      { ...config, kind: 'remote', apiKey: 'secret' },
      fetchImpl
    );
    const controller = new AbortController();

    const vectors = await provider.embed(['a', 'b'], controller.signal);
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4]
    ]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/v1/embeddings');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body)).toEqual({ model: 'nomic-embed-text', input: ['a', 'b'] });
  });

  it('rejects malformed or inconsistent embeddings', async () => {
    const empty = vi.fn(async () => json({ data: [{ embedding: [] }] })) as unknown as FetchLike;
    await expect(new OpenAiCompatibleProvider(config, empty).embed(['a'])).rejects.toThrow(
      '格式不正确'
    );

    const asObject = vi.fn(async () => json({ data: { embedding: [1] } })) as unknown as FetchLike;
    await expect(new OpenAiCompatibleProvider(config, asObject).embed(['a'])).rejects.toThrow(
      '格式不正确'
    );

    const wrongCount = vi.fn(async () => json({ data: [{ embedding: [1, 2] }] })) as unknown as FetchLike;
    await expect(new OpenAiCompatibleProvider(config, wrongCount).embed(['a', 'b'])).rejects.toThrow(
      '格式不正确'
    );

    const wrongDim = vi.fn(async () =>
      json({ data: [{ embedding: [1, 2] }, { embedding: [1, 2, 3] }] })
    ) as unknown as FetchLike;
    await expect(new OpenAiCompatibleProvider(config, wrongDim).embed(['a', 'b'])).rejects.toThrow(
      '维度不一致'
    );
  });

  it('chats through /chat/completions and returns the first message', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ choices: [{ message: { content: '草稿内容' } }] })
    ) as unknown as FetchLike;
    const provider = new OpenAiCompatibleProvider(config, fetchImpl);
    const controller = new AbortController();

    const answer = await provider.chat([{ role: 'user', content: '写一段' }], {
      temperature: 0.1,
      signal: controller.signal
    });
    expect(answer).toBe('草稿内容');
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body)).toEqual({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: '写一段' }],
      temperature: 0.1,
      stream: false
    });
  });

  it('surfaces HTTP status with the server reason and rejects empty answers', async () => {
    const failing = vi.fn(async () =>
      json({ error: { message: 'invalid api key' } }, 401)
    ) as unknown as FetchLike;
    await expect(
      new OpenAiCompatibleProvider(config, failing).chat([{ role: 'user', content: 'x' }])
    ).rejects.toThrow('401：invalid api key');

    const notJson = vi.fn(
      async () => new Response('<html>bad</html>', { status: 200 })
    ) as unknown as FetchLike;
    await expect(
      new OpenAiCompatibleProvider(config, notJson).chat([{ role: 'user', content: 'x' }])
    ).rejects.toThrow('非 JSON');

    const empty = vi.fn(async () => json({ choices: [] })) as unknown as FetchLike;
    await expect(
      new OpenAiCompatibleProvider(config, empty).chat([{ role: 'user', content: 'x' }])
    ).rejects.toThrow('没有返回内容');
  });
});

describe('provider factories (chat / embedding)', () => {
  it('refuses remote endpoints until that endpoint is authorized', () => {
    expect(() => createChatProvider(DEFAULT_AI_SETTINGS)).toThrow('对话服务');
    expect(() => createChatProvider(DEFAULT_AI_SETTINGS)).toThrow('未获授权');
    expect(() => createEmbeddingProvider(DEFAULT_AI_SETTINGS)).toThrow('嵌入服务');
    expect(() => createEmbeddingProvider(DEFAULT_AI_SETTINGS)).toThrow('未获授权');
  });

  it('creates a chat provider from the chat endpoint only', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ choices: [{ message: { content: 'ok' } }] })
    ) as unknown as FetchLike;
    const provider = createChatProvider(
      settings(
        remoteEndpoint('http://chat.example.com/v1', 'deepseek-chat'),
        localEndpoint('BAAI/bge-m3')
      ),
      fetchImpl
    );
    expect(provider.id).toBe('openai-compatible:remote:deepseek-chat');
    await provider.chat([{ role: 'user', content: 'x' }]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://chat.example.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('creates an embedding provider from the embedding endpoint only', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ data: [{ embedding: [0.1, 0.2] }] })
    ) as unknown as FetchLike;
    const provider = createEmbeddingProvider(
      settings(
        localEndpoint('deepseek-chat'),
        remoteEndpoint('https://api.siliconflow.cn/v1', 'BAAI/bge-m3', { apiKey: 'sf' })
      ),
      fetchImpl
    );
    await provider.embed(['hello']);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.siliconflow.cn/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sf');
    expect(JSON.parse(init.body).model).toBe('BAAI/bge-m3');
  });

  it('never sends an API key to a loopback endpoint', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ choices: [{ message: { content: 'ok' } }] })
    ) as unknown as FetchLike;
    const provider = createChatProvider(
      settings(localEndpoint('deepseek-chat', { apiKey: 'secret' }), localEndpoint('BAAI/bge-m3')),
      fetchImpl
    );
    await provider.chat([{ role: 'user', content: 'x' }]);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });
});
